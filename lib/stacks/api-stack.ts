import {
  Stack,
  StackProps,
  Duration,
  aws_logs as logs,
  aws_apigateway as apigw,
  aws_lambda as lambda,
  aws_cognito as cognito,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "path";
import { Fn } from "aws-cdk-lib";

interface ApiStackProps extends StackProps {
  assetPath?: string;
  environmentType?: string;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  stage: string; // Add stage prop
}

export class ApiStack extends Stack {
  public readonly api: apigw.RestApi;
  public readonly identityPool: cognito.CfnIdentityPool;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { assetPath, environmentType, userPool, userPoolClient, stage } =
      props;

    const apiGwLogsRole = new iam.Role(
      this,
      `WorkoutTracer-ApiGatewayCloudWatchRole-${stage}`,
      {
        assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        inlinePolicies: {
          ApiGwCloudWatchLogsPolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  "logs:CreateLogGroup",
                  "logs:CreateLogStream",
                  "logs:DescribeLogGroups",
                  "logs:DescribeLogStreams",
                  "logs:PutLogEvents",
                ],
                resources: ["*"],
              }),
            ],
          }),
        },
      },
    );

    new apigw.CfnAccount(this, `WorkoutTracer-ApiGatewayAccount-${stage}`, {
      cloudWatchRoleArn: apiGwLogsRole.roleArn,
    });

    const layer = new lambda.LayerVersion(
      this,
      `WorkoutTracer-ApiLayer-${stage}`,
      {
        code: lambda.Code.fromAsset(
          assetPath
            ? path.join(assetPath, "lambda_layer.zip")
            : path.join(
                __dirname,
                "../../../workout_tracer_api/lambda_layer.zip",
              ),
        ),
        compatibleRuntimes: [lambda.Runtime.PYTHON_3_11],
        description: "WorkoutTracer Lambda layer with dependencies",
      },
    );

    const applicationLogsLogGroup = new logs.LogGroup(
      this,
      `WorkoutTracer-ApplicationLogs-${stage}`,
      {
        logGroupName: `/aws/lambda/WorkoutTracerApi-${stage}`,
        retention: logs.RetentionDays.INFINITE,
      },
    );

    const workoutTracerApi = new lambda.Function(
      this,
      `WorkoutTracer-ApiLambda-${stage}`,
      {
        functionName: `WorkoutTracerApi-${stage}`,
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: "app.handler",
        code: lambda.Code.fromAsset(
          assetPath || path.join(__dirname, "../../../workout_tracer_api"),
        ),
        timeout: Duration.seconds(10),
        layers: [layer],
        logGroup: applicationLogsLogGroup,
      },
    );

    // CloudWatch Log Group for API Gateway access logs
    const accessLogGroup = new logs.LogGroup(
      this,
      `WorkoutTracer-ServiceLogs-${stage}`,
      {
        logGroupName: `/aws/apigateway/WorkoutTracerServiceLogs-${stage}`,
        retention: logs.RetentionDays.INFINITE,
      },
    );

    // Identity Pool setup
    this.identityPool = new cognito.CfnIdentityPool(
      this,
      `WorkoutTracer-IdentityPool-${stage}`,
      {
        allowUnauthenticatedIdentities: false,
        cognitoIdentityProviders: [
          {
            clientId: userPoolClient.userPoolClientId,
            providerName: userPool.userPoolProviderName,
          },
        ],
      },
    );

    this.api = new apigw.RestApi(this, `WorkoutTracer-RestApi-${stage}`, {
      restApiName: `WorkoutTracerApi-${stage}`,
      deployOptions: {
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigw.AccessLogFormat.custom(
          JSON.stringify({
            requestId: "$context.requestId",
            caller: "$context.identity.caller",
            httpMethod: "$context.httpMethod",
            ip: "$context.identity.sourceIp",
            protocol: "$context.protocol",
            requestTime: "$context.requestTime",
            resourcePath: "$context.resourcePath",
            responseLength: "$context.responseLength",
            status: "$context.status",
            user: "$context.identity.user",
            errorMessage: "$context.error.message",
            errorResponseType: "$context.error.responseType",
          }),
        ),
        loggingLevel: apigw.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
    });

    const rootIntegration = new apigw.LambdaIntegration(workoutTracerApi);
    this.api.root.addMethod("GET", rootIntegration);
  }
}

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

interface ApiStackProps extends StackProps {
  assetPath?: string;
  environmentType?: string; // "local" or "pipeline"
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
}

export class ApiStack extends Stack {
  public readonly api: apigw.RestApi;
  public readonly identityPool: cognito.CfnIdentityPool;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { assetPath, environmentType, userPool, userPoolClient } = props;

    const apiGwLogsRole = new iam.Role(this, "ApiGatewayCloudWatchRole", {
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
    });

    new apigw.CfnAccount(this, "ApiGatewayAccount", {
      cloudWatchRoleArn: apiGwLogsRole.roleArn,
    });

    const layer = new lambda.LayerVersion(this, "WorkoutTracerApiLayer", {
      code: lambda.Code.fromAsset(
        assetPath
          ? path.join(assetPath, "layer")
          : path.join(__dirname, "../../../workout_tracer_api/layer"),
      ),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_11],
      description: "WorkoutTracer Lambda layer with dependencies",
    });

    // Define Lambda function
    const apiHandler = new lambda.Function(this, "WorkoutTracerApiHandler", {
      functionName: "WorkoutTracerApiHandler",
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: "main.handler",
      code: lambda.Code.fromAsset(
        assetPath || path.join(__dirname, "../../../workout_tracer_api"),
      ),
      timeout: Duration.seconds(10),
      layers: [layer],
    });

    // CloudWatch Log Group for API Gateway access logs
    const accessLogGroup = new logs.LogGroup(this, "WorkoutTracerServiceLogs", {
      logGroupName: "/aws/apigateway/WorkoutTracerServiceLogs",
      retention: logs.RetentionDays.INFINITE,
    });

    // Identity Pool setup
    this.identityPool = new cognito.CfnIdentityPool(
      this,
      "WorkoutTracerIdentityPool",
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

    // Create API Gateway and attach Lambda integration
    this.api = new apigw.RestApi(this, "WorkoutTracerRestApi", {
      restApiName: "WorkoutTracerApi",
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

    const rootIntegration = new apigw.LambdaIntegration(apiHandler);
    this.api.root.addMethod("GET", rootIntegration);
  }
}

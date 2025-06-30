import {
  Stack,
  StackProps,
  Duration,
  aws_logs as logs,
  aws_apigateway as apigw,
  aws_lambda as lambda,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_kms as kms,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "path";
import { addApiMonitoring } from "../monitoring/apiMonitoring";

interface ApiStackProps extends StackProps {
  apiDomainName: string;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  stage: string;
  userTable: dynamodb.ITable;
  escalationEmail: string,
  escalationNumber: string
}

export class ApiStack extends Stack {
  public readonly api: apigw.LambdaRestApi;
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly kmsKey: kms.IKey;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { apiDomainName, userPool, userPoolClient, userTable, stage, escalationEmail, escalationNumber } = props;

    const kmsKey = new kms.Key(this, `WorkoutTracer-KMSKey-${stage}`, {
      description: `KMS Key for WorkoutTracer API Stack - ${stage}`,
      enableKeyRotation: true,
      alias: `alias/WorkoutTracer/API/${stage}`,
    });
    this.kmsKey = kmsKey;

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
          path.join(__dirname, "../../../workout_tracer_api/lambda_layer.zip"),
        ),
        compatibleRuntimes: [lambda.Runtime.PYTHON_3_11],
        description: `WorkoutTracer-ApiLayer-${stage}`,
      },
    );

    const applicationLogsLogGroup = new logs.LogGroup(
      this,
      `WorkoutTracer-ApplicationLogs-${stage}`,
      {
        logGroupName: `/aws/lambda/WorkoutTracer-ApiLambda-${stage}`,
        retention: logs.RetentionDays.INFINITE,
      },
    );

    const workoutTracerApi = new lambda.Function(
      this,
      `WorkoutTracer-ApiLambda-${stage}`,
      {
        functionName: `WorkoutTracer-ApiLambda-${stage}`,
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: "app.handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../workout_tracer_api"),
        ),
        timeout: Duration.seconds(30),
        layers: [layer],
        logGroup: applicationLogsLogGroup,
        tracing: lambda.Tracing.ACTIVE,
        description: `WorkoutTracer-ApiLambda-${stage}`,
        environment: {
          TABLE_NAME: userTable.tableName,
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
          COGNITO_API_REDIRECT_URI: `https://${apiDomainName}/`,
          COGNITO_REGION: "us-west-2",
          COGNITO_DOMAIN:
            stage.toLowerCase() === "prod"
              ? "https://workouttracer.auth.us-west-2.amazoncognito.com"
              : `https://workouttracer-${stage.toLowerCase()}.auth.us-west-2.amazoncognito.com`,
          STAGE: stage.toLowerCase(),
          KMS_KEY_ARN: kmsKey.keyArn,
          DLQ_NAME: `WorkoutTracer-RateLimitedBatcherQueue-${stage.toLowerCase()}`,
          API_DOMAIN_NAME: apiDomainName,
          STRAVA_ONBOARDING_LAMBDA_ARN: `arn:aws:lambda:${this.region}:${this.account}:function:WorkoutTracer-StravaOnboardingLambda-${stage}`,
        },
      },
    );

    workoutTracerApi.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "cloudwatch:PutMetricData",
        ],
        resources: ["*"],
      }),
    );

    workoutTracerApi.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
          "sqs:ChangeMessageVisibility",
        ],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:WorkoutTracer-RateLimitedBatcherQueue-${stage}`,
          `arn:aws:sqs:${this.region}:${this.account}:WorkoutTracer-RateLimitedBatcherDLQ-${stage}`,
        ],
      }),
    );

    workoutTracerApi.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:StravaKeys*`,
        ],
      }),
    );

    workoutTracerApi.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:WorkoutTracer-StravaOnboardingLambda-${stage}`,
        ],
      }),
    );

    kmsKey.grantEncryptDecrypt(workoutTracerApi);
    userTable.grantReadWriteData(workoutTracerApi);

    const accessLogGroup = new logs.LogGroup(
      this,
      `WorkoutTracer-ServiceLogs-${stage}`,
      {
        logGroupName: `/aws/apigateway/WorkoutTracer-ServiceLogs-${stage}`,
        retention: logs.RetentionDays.INFINITE,
      },
    );

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

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(
      this,
      `WorkoutTracer-ApiAuthorizer-${stage}`,
      {
        cognitoUserPools: [userPool],
        authorizerName: `WorkoutTracer-ApiAuthorizer-${stage}`,
        identitySource: "method.request.header.Authorization",
      },
    );

    this.api = new apigw.LambdaRestApi(
      this,
      `WorkoutTracer-LambdaRestApi-${stage}`,
      {
        handler: workoutTracerApi,
        restApiName: `WorkoutTracer-Api-${stage}`,
        proxy: false, // <-- change to false to allow custom resources
        defaultMethodOptions: {
          authorizationType: apigw.AuthorizationType.COGNITO,
          authorizer,
        },
        defaultCorsPreflightOptions: {
          allowOrigins:
            stage.toLowerCase() === "prod"
              ? ["https://workouttracer.com"]
              : stage.toLowerCase() === "staging"
                ? ["https://staging.workouttracer.com", "http://localhost:8080"]
                : ["http://localhost:8080"],
          allowMethods: apigw.Cors.ALL_METHODS,
          allowHeaders: ["authorization", "content-type"],
          allowCredentials: true,
        },
        deployOptions: {
          tracingEnabled: true,
          accessLogDestination: new apigw.LogGroupLogDestination(
            accessLogGroup,
          ),
          accessLogFormat: apigw.AccessLogFormat.custom(
            JSON.stringify({
              requestId: "$context.requestId",
              user_id: "$context.authorizer.claims.sub",
              resourcePath: "$context.path",
              httpMethod: "$context.httpMethod",
              ip: "$context.identity.sourceIp",
              status: "$context.status",
              errorMessage: "$context.error.message",
              errorResponseType: "$context.error.responseType",
              auth_raw: "$context.authorizer",
            }),
          ),
          loggingLevel: apigw.MethodLoggingLevel.INFO,
          dataTraceEnabled: true,
          description: `WorkoutTracer-ApiGateway-Deployment-${stage}`,
        },
      },
    );

    // Create /strava resource first, then add children
    const stravaResource = this.api.root.addResource("strava");

    const webhookResource = stravaResource.addResource("webhook");
      webhookResource.addMethod(
        "GET",
        new apigw.LambdaIntegration(workoutTracerApi),
        { authorizationType: apigw.AuthorizationType.NONE }
      );
      webhookResource.addMethod(
        "POST",
        new apigw.LambdaIntegration(workoutTracerApi),
        { authorizationType: apigw.AuthorizationType.NONE }
      );

    const docsResource = this.api.root.addResource("docs");
    docsResource.addMethod(
      "GET",
      new apigw.LambdaIntegration(workoutTracerApi),
      {
        authorizationType: apigw.AuthorizationType.NONE,
      }
    );

    // Allow unauthenticated access to /docs/{proxy+} (static assets)
    const docsProxyResource = docsResource.addResource("{proxy+}");
    docsProxyResource.addMethod(
      "ANY",
      new apigw.LambdaIntegration(workoutTracerApi),
      {
        authorizationType: apigw.AuthorizationType.NONE,
      }
    );

    const openapiResource = this.api.root.addResource("openapi.json");
    openapiResource.addMethod(
      "GET",
      new apigw.LambdaIntegration(workoutTracerApi),
      {
        authorizationType: apigw.AuthorizationType.NONE,
      }
    );

    const proxyResource = this.api.root.addResource("{proxy+}");
    proxyResource.addMethod(
      "ANY",
      new apigw.LambdaIntegration(workoutTracerApi),
      {
        authorizationType: apigw.AuthorizationType.COGNITO,
        authorizer,
      }
    );

    addApiMonitoring(this, this.api, stage, escalationEmail, escalationNumber);
  }
}

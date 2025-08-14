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
  escalationEmail: string;
  escalationNumber: string;
}

export class ApiStack extends Stack {
  public readonly api: apigw.LambdaRestApi;
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly kmsKey: kms.IKey;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const {
      apiDomainName,
      userPool,
      userPoolClient,
      userTable,
      stage,
      escalationEmail,
      escalationNumber,
    } = props;

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
        memorySize: 1024,
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
          STRAVA_ONBOARDING_LAMBDA_ARN: `arn:aws:lambda:${this.region}:${this.account}:function:WorkoutTracer-StravaOnboardingLambdaV2-${stage}`,
        },
      },
    );

    workoutTracerApi.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
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
          `arn:aws:lambda:${this.region}:${this.account}:function:WorkoutTracer-StravaOnboardingLambdaV2-${stage}`,
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
        proxy: false,
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
              email: "$context.authorizer.claims.email",
              name: "$context.authorizer.claims.name",
              resourcePath: "$context.path",
              httpMethod: "$context.httpMethod",
              ip: "$context.identity.sourceIp",
              status: "$context.status",
              errorMessage: "$context.error.message",
              errorResponseType: "$context.error.responseType",
              auth_raw: "$context.authorizer",
              xrayTraceId: "$context.xrayTraceId",
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
      { authorizationType: apigw.AuthorizationType.NONE },
    );
    webhookResource.addMethod(
      "POST",
      new apigw.LambdaIntegration(workoutTracerApi),
      { authorizationType: apigw.AuthorizationType.NONE },
    );

    // Add /strava/profile/callback POST endpoint with Cognito authorizer
    const profileResource = stravaResource.addResource("profile");
    const callbackResource = profileResource.addResource("callback");
    callbackResource.addMethod(
      "POST",
      new apigw.LambdaIntegration(workoutTracerApi),
      {
        authorizationType: apigw.AuthorizationType.COGNITO,
        authorizer,
      },
    );

    const docsResource = this.api.root.addResource("docs");
    docsResource.addMethod(
      "GET",
      new apigw.LambdaIntegration(workoutTracerApi),
      {
        authorizationType: apigw.AuthorizationType.NONE,
      },
    );

    // Allow unauthenticated access to /docs/{proxy+} (static assets)
    const docsProxyResource = docsResource.addResource("{proxy+}");
    docsProxyResource.addMethod(
      "ANY",
      new apigw.LambdaIntegration(workoutTracerApi),
      {
        authorizationType: apigw.AuthorizationType.NONE,
      },
    );

    // Add a /robots.txt resource that returns a static response and does NOT require auth or Lambda
    const robotsResource = this.api.root.addResource("robots.txt");
    robotsResource.addMethod(
      "GET",
      new apigw.MockIntegration({
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              "text/plain": "User-agent: *\nDisallow:\n",
            },
          },
        ],
        passthroughBehavior: apigw.PassthroughBehavior.NEVER,
        requestTemplates: {
          "application/json": '{"statusCode": 200}',
        },
      }),
      {
        methodResponses: [
          {
            statusCode: "200",
            responseModels: {
              "text/plain": apigw.Model.EMPTY_MODEL,
            },
          },
        ],
        authorizationType: apigw.AuthorizationType.NONE,
      },
    );

    const openapiResource = this.api.root.addResource("openapi.json");
    openapiResource.addMethod(
      "GET",
      new apigw.LambdaIntegration(workoutTracerApi),
      {
        authorizationType: apigw.AuthorizationType.NONE,
      },
    );

    const proxyResource = this.api.root.addResource("{proxy+}");
    proxyResource.addMethod(
      "ANY",
      new apigw.LambdaIntegration(workoutTracerApi),
      {
        authorizationType: apigw.AuthorizationType.COGNITO,
        authorizer,
      },
    );

    // Log group for LogDivingLambda
    const logDivingLogGroup = new logs.LogGroup(
      this,
      `WorkoutTracer-LogDivingLambdaLogGroup-${stage}`,
      {
        logGroupName: `/aws/lambda/WorkoutTracer-LogDivingLambda-${stage}`,
        retention: logs.RetentionDays.ONE_MONTH,
      },
    );

    // LogDiving Lambda
    const logDivingLambda = new lambda.Function(
      this,
      `WorkoutTracer-LogDivingLambda-${stage}`,
      {
        functionName: `WorkoutTracer-LogDivingLambda-${stage}`,
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: "lambdas.log_diver.lambda_handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../workout_tracer_api"),
        ),
        timeout: Duration.minutes(15),
        memorySize: 1024,
        layers: [layer],
        logGroup: logDivingLogGroup,
        description: `Log diving and investigation Lambda for ${stage}`,
        environment: {
          STAGE: stage,
        },
      },
    );

    // Permissions for Bedrock
    logDivingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModel"],
        resources: ["*"],
      }),
    );

    // Permissions for S3 (update bucket names to lowercase and allow all object actions)
    logDivingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:CreateBucket",
          "s3:HeadBucket",
          "s3:DeleteObject",
          "s3:GetObjectAcl",
          "s3:PutObjectAcl",
        ],
        resources: [
          `arn:aws:s3:::workouttracer-investigations-${stage.toLowerCase()}`,
          `arn:aws:s3:::workouttracer-investigations-${stage.toLowerCase()}/*`,
        ],
      }),
    );

    // Permissions for CloudWatch Logs Insights (use wildcard for all streams in log group)
    logDivingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:StartQuery",
          "logs:GetQueryResults",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
          "logs:FilterLogEvents",
          "logs:GetLogEvents",
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/apigateway/WorkoutTracer-ServiceLogs-${stage}:*`,
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/WorkoutTracer-ApiLambda-${stage}:*`,
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/WorkoutTracer-LogDivingLambda-${stage}:*`,
        ],
      }),
    );

    // Allow creating log streams/events in its own log group
    logDivingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/WorkoutTracer-LogDivingLambda-${stage}:*`,
        ],
      }),
    );

    // If you use KMS encryption for S3/logs, grant decrypt/encrypt
    kmsKey.grantEncryptDecrypt(logDivingLambda);

    addApiMonitoring(this, this.api, stage, escalationEmail, escalationNumber);
  }
}

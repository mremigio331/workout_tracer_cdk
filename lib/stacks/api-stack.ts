import {
  Stack,
  StackProps,
  Duration,
  aws_logs as logs,
  aws_apigateway as apigw,
  aws_lambda as lambda,
  aws_cognito as cognito,
  aws_cloudwatch as cloudwatch,
  aws_dynamodb as dynamodb,
  aws_kms as kms,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "path";

interface ApiStackProps extends StackProps {
  apiDomainName: string;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  stage: string;
  userTable: dynamodb.ITable;
}

export class ApiStack extends Stack {
  public readonly api: apigw.LambdaRestApi;
  public readonly identityPool: cognito.CfnIdentityPool;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { apiDomainName, userPool, userPoolClient, userTable, stage } = props;

    const kmsKey = new kms.Key(this, `WorkoutTracer-KMSKey-${stage}`, {
      description: `KMS Key for WorkoutTracer API Stack - ${stage}`,
      enableKeyRotation: true,
      alias: `alias/WorkoutTracer/API/${stage}`,
    });

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
        timeout: Duration.seconds(10),
        layers: [layer],
        logGroup: applicationLogsLogGroup,
        tracing: lambda.Tracing.ACTIVE,
        description: `WorkoutTracer-ApiLambda-${stage}`,
        environment: {
          TABLE_NAME: userTable.tableName,
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          COGNITO_USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
          COGNITO_API_REDIRECT_URI: apiDomainName,
          COGNITO_DOMAIN: `https://workouttracer-${stage}.auth.us-west-2.amazoncognito.com`,
          STAGE: stage,
          KMS_KEY_ARN: kmsKey.keyArn,
        },
      },
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

    // Create Cognito Authorizer
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
        proxy: true,
        defaultMethodOptions: {
          authorizationType: apigw.AuthorizationType.COGNITO,
          authorizer,
        },
        defaultCorsPreflightOptions: {
          allowOrigins: apigw.Cors.ALL_ORIGINS,
          allowMethods: apigw.Cors.ALL_METHODS,
          allowHeaders: ["*"],
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
              resourcePath: "$context.resourcePath",
              httpMethod: "$context.httpMethod",
              ip: "$context.identity.sourceIp",
              status: "$context.status",
              errorMessage: "$context.error.message",
              errorResponseType: "$context.error.responseType",
            }),
          ),
          loggingLevel: apigw.MethodLoggingLevel.INFO,
          dataTraceEnabled: true,
          description: `WorkoutTracer-ApiGateway-Deployment-${stage}`,
        },
      },
    );

    // === CloudWatch Metrics for API Gateway ===
    const apiGatewayName = `WorkoutTracer-Api-${stage}`;
    const apiStageName = this.api.deploymentStage.stageName;

    // 2XX metric
    const api2xxMetric = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "2XXError",
      dimensionsMap: {
        ApiName: apiGatewayName,
        Stage: apiStageName,
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    });

    // 4XX metric
    const api4xxMetric = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "4XXError",
      dimensionsMap: {
        ApiName: apiGatewayName,
        Stage: apiStageName,
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    });

    // Count metric (total requests)
    const apiCountMetric = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "Count",
      dimensionsMap: {
        ApiName: apiGatewayName,
        Stage: apiStageName,
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    });

    // Math expression for 4XX error rate (%)
    const api4xxRate = new cloudwatch.MathExpression({
      expression: "100 * (fourxx / total)",
      usingMetrics: {
        fourxx: api4xxMetric,
        total: apiCountMetric,
      },
      label: "4XX Error Rate (%)",
      period: Duration.minutes(5),
    });

    // Alarm for 4XX error rate > 40%
    const api4xxRateAlarm = new cloudwatch.Alarm(
      this,
      `WorkoutTracer-Api-4XXRateAlarm-${stage}`,
      {
        alarmName: `WorkoutTracer-Api-4XXRateAlarm-${stage}`,
        metric: api4xxRate,
        threshold: 40,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `WorkoutTracer-Api-4XXRateAlarm-${stage}: Alarm if 4XX error rate exceeds 40% on API Gateway (${stage})`,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      },
    );

    // 5XX metric
    const api5xxMetric = new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "5XXError",
      dimensionsMap: {
        ApiName: apiGatewayName,
        Stage: apiStageName,
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    });

    // === Alarm for 5XX errors ===
    const api5xxAlarm = new cloudwatch.Alarm(
      this,
      `WorkoutTracer-Api-5XXAlarm-${stage}`,
      {
        alarmName: `WorkoutTracer-Api-5XXAlarm-${stage}`,
        metric: api5xxMetric,
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `WorkoutTracer-Api-5XXAlarm-${stage}: Alarm if any 5XX errors occur on API Gateway (${stage})`,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      },
    );
  }
}

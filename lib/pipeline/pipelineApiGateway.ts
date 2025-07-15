import {
  Stack,
  aws_apigateway as apigateway,
  aws_lambda as lambda,
  aws_logs as logs,
  RemovalPolicy,
  Duration,
} from "aws-cdk-lib";

export function createPipelineApiGateway(
  scope: Stack,
  webhookAuthorizerLambda: lambda.IFunction,
  pipelineDeployLambda: lambda.IFunction,
) {
  const apiLogGroup = new logs.LogGroup(scope, "WebhookApiLogGroup", {
    logGroupName: "WorkoutTracer-GithubWebhok-API",
    removalPolicy: RemovalPolicy.DESTROY,
    retention: logs.RetentionDays.ONE_MONTH,
  });

  const api = new apigateway.RestApi(scope, "WorkoutTracerWebhookAPI", {
    description: "API for Workout Tracer GitHub Webhook",
    restApiName: "WorkoutTracerApi-GithubWebhook",
    deployOptions: {
      stageName: "prod",
      accessLogDestination: new apigateway.LogGroupLogDestination(apiLogGroup),
      accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
        caller: true,
        httpMethod: true,
        ip: true,
        protocol: true,
        requestTime: true,
        resourcePath: true,
        responseLength: true,
        status: true,
        user: true,
      }),
      loggingLevel: apigateway.MethodLoggingLevel.INFO,
      dataTraceEnabled: true,
    },
  });

  const requestAuthorizer = new apigateway.RequestAuthorizer(
    scope,
    "GitHubAuthorizer",
    {
      handler: webhookAuthorizerLambda,
      identitySources: [
        apigateway.IdentitySource.header("X-Hub-Signature-256"),
      ],
      resultsCacheTtl: Duration.seconds(0),
    },
  );

  const webhookResource = api.root.addResource("github-webhook");

  webhookResource.addMethod(
    "POST",
    new apigateway.LambdaIntegration(pipelineDeployLambda, {
      proxy: true,
    }),
    {
      authorizer: requestAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      methodResponses: [
        { statusCode: "200" },
        { statusCode: "401" },
        { statusCode: "403" },
      ],
    },
  );

  return { api, requestAuthorizer };
}

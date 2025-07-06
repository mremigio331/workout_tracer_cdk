import { Stack, aws_lambda as lambda, aws_secretsmanager as secretsmanager, Duration } from "aws-cdk-lib";
import * as path from "path";

export function createPipelineDeployLambda(scope: Stack, layer: lambda.LayerVersion) {
  return new lambda.Function(
    scope,
    `WorkoutTracer-PipelineDeployLambda`,
    {
      functionName: `WorkoutTracer-PipelineDeployLambda`,
      description: "Lambda function to deploy the Workout Tracer pipeline",
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: "lambdas.pipeline_deployment.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../../workout_tracer_api"),
      ),
      timeout: Duration.seconds(10),
      layers: [layer],
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        PIPELINE: "WorkoutTracerPipeline",
      },
    },
  );
}

export function createWebhookAuthorizerLambda(scope: Stack, githubSecret: secretsmanager.ISecret, layer?: lambda.LayerVersion) {
  const fn = new lambda.Function(
    scope,
    "GitHubWebhookAuthorizer",
    {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: "lambdas.github_auth.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../../workout_tracer_api"),
      ),
      timeout: Duration.seconds(5),
      environment: {
        GITHUB_WEBHOOK_SECRET_ARN: githubSecret.secretArn,
      },
      layers: layer ? [layer] : [],
    },
  );
  githubSecret.grantRead(fn);
  return fn;
}

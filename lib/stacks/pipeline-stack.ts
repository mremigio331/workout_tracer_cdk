import {
  Stack,
  StackProps,
  aws_codepipeline as codepipeline,
  aws_codepipeline_actions as codepipeline_actions,
  aws_iam as iam,
  aws_secretsmanager as secretsmanager,
  aws_logs as logs,
  aws_s3 as s3,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatch_actions,
  aws_sns as sns,
  aws_apigateway as apigateway,
  aws_lambda as lambda,
  RemovalPolicy,
  Duration,
} from "aws-cdk-lib";
import * as path from "path";

import { Construct } from "constructs";
import { addPipelineMonitoring } from "../monitoring/pipelineMonitoring";
import {
  createPipelineDeployLambda,
  createWebhookAuthorizerLambda,
} from "../pipeline/pipelineLambdas";
import { createPipelineApiGateway } from "../pipeline/pipelineApiGateway";
import {
  createBuildProject,
  createStagingDeployProject,
  createProdDeployProject,
} from "../pipeline/pipelineBuildProjects";
import { createDeploymentBucket } from "../pipeline/pipelineBucket";

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Lambda Layer
    const layer = new lambda.LayerVersion(
      this,
      `WorkoutTracer-PipelineStackLayer`,
      {
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../workout_tracer_api/lambda_layer.zip"),
        ),
        compatibleRuntimes: [lambda.Runtime.PYTHON_3_11],
        description: `WorkoutTracer-PipelineStackLayer`,
      },
    );

    // Secrets
    const githubSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "GitHubWebhookSecret",
      "GithubToken",
    );

    // Lambda Functions
    const pipelineDeplyLambda = createPipelineDeployLambda(this, layer);
    const webhookAuthorizerLambda = createWebhookAuthorizerLambda(
      this,
      githubSecret,
      layer,
    );

    // Grant permission to start the pipeline
    pipelineDeplyLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codepipeline:StartPipelineExecution"],
        resources: [
          `arn:aws:codepipeline:${this.region}:${this.account}:WorkoutTracerPipeline`,
        ],
      }),
    );

    // Grant permission to read the GitHub secret from Secrets Manager
    webhookAuthorizerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:my-github-token*`,
        ],
      }),
    );

    // API Gateway
    const { api, requestAuthorizer } = createPipelineApiGateway(
      this,
      webhookAuthorizerLambda,
      pipelineDeplyLambda,
    );

    // Artifacts
    const sourceArtifact = new codepipeline.Artifact("SourceOutput");
    const buildArtifact = new codepipeline.Artifact("BuildOutput");

    // IAM Role
    const cdkPipelineRole = new iam.Role(this, "CdkPipelineRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"),
      ],
    });

    // CodeBuild Projects
    const buildProject = createBuildProject(this, cdkPipelineRole);
    const stagingDeployProject = createStagingDeployProject(
      this,
      cdkPipelineRole,
    );
    const prodDeployProject = createProdDeployProject(this, cdkPipelineRole);

    // S3 Bucket
    const deploymentBucket = createDeploymentBucket(this);

    // Pipeline
    const pipeline = new codepipeline.Pipeline(this, "WorkoutTracer-Pipeline", {
      pipelineName: "WorkoutTracerPipeline",
      artifactBucket: deploymentBucket,
    });

    // Source stage (only one repo can be used as a CodePipeline source action)
    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: "GitHub_Source",
      owner: "mremigio331",
      repo: "workout_tracer_cdk",
      oauthToken: githubSecret.secretValueFromJson("GITHUB_TOKEN"),
      output: sourceArtifact,
      branch: "main",
    });

    pipeline.addStage({
      stageName: "Source",
      actions: [sourceAction],
    });

    // Build stage
    pipeline.addStage({
      stageName: "ArtifactsBuild",
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: "BuildAndPackage",
          project: buildProject,
          input: sourceArtifact,
          outputs: [buildArtifact],
        }),
      ],
    });

    // SNS Topic for pipeline alarms (add your email or endpoint here)
    const alarmTopic = new sns.Topic(this, "PipelineAlarmTopic", {
      displayName: "Pipeline Deployment Alarms",
    });

    // Add all pipeline monitoring/alarms
    addPipelineMonitoring(
      this,
      alarmTopic,
      pipeline,
      buildProject,
      stagingDeployProject,
      prodDeployProject,
    );

    // Staging deploy stage: one action per stack
    pipeline.addStage({
      stageName: "Staging",
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: "Deploy-Staging",
          project: stagingDeployProject,
          input: buildArtifact,
          runOrder: 1,
        }),
      ],
    });

    // Prod deploy stage: one action per stack
    pipeline.addStage({
      stageName: "Prod",
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: "Deploy-Prod",
          project: prodDeployProject,
          input: buildArtifact,
          runOrder: 1,
        }),
      ],
    });
  }
}

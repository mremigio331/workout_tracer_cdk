import {
  Stack,
  StackProps,
  aws_codepipeline as codepipeline,
  aws_codepipeline_actions as codepipeline_actions,
  aws_codebuild as codebuild,
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

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const layer = new lambda.LayerVersion(
      this,
      `WorkoutTracer-PipelineDeployLambdaLayer`,
      {
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../workout_tracer_api/lambda_layer.zip"),
        ),
        compatibleRuntimes: [lambda.Runtime.PYTHON_3_11],
        description: "WorkoutTracer Lambda layer with dependencies",
      },
    );

    const githubSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "GitHubWebhookSecret",
      "GithubToken",
    );

    const pipelineDeplyLambda = new lambda.Function(
      this,
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

    const webhookAuthorizerLambda = new lambda.Function(
      this,
      "GitHubWebhookAuthorizer",
      {
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: "lambdas.github_auth.handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../workout_tracer_api"),
        ),
        timeout: Duration.seconds(5),
      },
    );

    githubSecret.grantRead(webhookAuthorizerLambda);

    // Create a CloudWatch Log Group for API Gateway execution logs
    const apiLogGroup = new logs.LogGroup(this, "WebhookApiLogGroup", {
      logGroupName: "WorkoutTracer-GithubWebhok-API",
      removalPolicy: RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const api = new apigateway.RestApi(this, "WorkoutTracerWebhookAPI", {
      description: "API for Workout Tracer GitHub Webhook",
      restApiName: "WorkoutTracerApi-GithubWebhook",
      deployOptions: {
        stageName: "prod",
        accessLogDestination: new apigateway.LogGroupLogDestination(
          apiLogGroup,
        ),
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
      this,
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
      new apigateway.LambdaIntegration(pipelineDeplyLambda),
      {
        authorizer: requestAuthorizer,
        authorizationType: apigateway.AuthorizationType.CUSTOM,
        methodResponses: [{ statusCode: "200" }],
      },
    );
    // Load GitHub PAT from Secrets Manager (secret name: 'GithubToken', key: 'GITHUB_TOKEN')
    const githubToken = secretsmanager.Secret.fromSecretNameV2(
      this,
      "GithubToken",
      "GithubToken",
    );

    // Define artifacts
    const sourceArtifact = new codepipeline.Artifact("SourceOutput");
    const buildArtifact = new codepipeline.Artifact("BuildOutput");

    // Create a role with full CDK permissions for all pipeline stages
    const cdkPipelineRole = new iam.Role(this, "CdkPipelineRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"),
      ],
      // Optionally, add inline policies for more control
    });

    // Build Project: clone repos, build layer, build website, prepare artifacts
    const buildProject = new codebuild.PipelineProject(
      this,
      "WorkoutTracer-BuildProject",
      {
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          privileged: true,
          environmentVariables: {
            GITHUB_TOKEN: {
              type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
              value: "GithubToken:GITHUB_TOKEN",
            },
          },
        },
        logging: {
          cloudWatch: {
            logGroup: new logs.LogGroup(this, "BuildProjectLogGroup", {
              logGroupName: "/aws/codebuild/WorkoutTracer-Pipeline",
              removalPolicy: RemovalPolicy.DESTROY,
              retention: logs.RetentionDays.ONE_MONTH,
            }),
          },
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: "0.2",
          phases: {
            install: {
              commands: [
                'echo "Configuring git for GitHub token..."',
                'git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"',
                // Remove 'cd workout_tracer_cdk' from here
                "git clone https://github.com/mremigio331/workout_tracer_cdk.git",
                "git clone https://github.com/mremigio331/workout_tracer_website.git",
                "git clone https://github.com/mremigio331/workout_tracer_api.git",
                "cd workout_tracer_cdk",
                "npm install",
              ],
            },
            pre_build: {
              commands: [
                'echo "Preparing API Lambda layer..."',
                "ls -al", // Add this line to debug directory contents
                "cd ../workout_tracer_api || cd workout_tracer_api", // Try both relative and direct
                "ls -al", // Debug inside the directory
                "pip install -r requirements.txt -t layer/python",
                "cd layer && zip -r9 ../lambda_layer.zip python",
                "cd ../..",
                'echo "Building website..."',
                "cd ../workout_tracer_website || cd workout_tracer_website",
                "npm install",
                'npm run build || npm run build:prod || echo "No build script found"',
                "cd ..",
                'echo "Installing CDK dependencies..."',
                "cd workout_tracer_cdk",
                "npm run build",
                "cd ..",
              ],
            },
            build: {
              commands: ['echo "Build complete."'],
            },
          },
          artifacts: {
            "base-directory": ".",
            files: [
              "workout_tracer_api/**/*",
              "workout_tracer_website/**/*",
              "workout_tracer_cdk/**/*",
            ],
          },
        }),
        role: cdkPipelineRole,
      },
    );

    // Grant the build project permission to read the GitHub token from Secrets Manager
    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [githubToken.secretArn],
      }),
    );

    // Staging Deploy Project: cdk deploy for all staging stacks in one command
    const stagingDeployProject = new codebuild.PipelineProject(
      this,
      "WorkoutTracer-StagingDeployProject",
      {
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          privileged: true,
          environmentVariables: {
            GITHUB_TOKEN: {
              type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
              value: "GithubToken:GITHUB_TOKEN",
            },
            CICD: { value: "true" },
            CDK_ENV_CONFIG: {
              type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
              value: "workout_tracer/cdk.env",
            },
          },
        },
        logging: {
          cloudWatch: {
            logGroup: logs.LogGroup.fromLogGroupName(
              this,
              "StagingProjectLogGroup",
              "/aws/codebuild/WorkoutTracer-Pipeline",
            ),
          },
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: "0.2",
          phases: {
            install: {
              commands: [
                "ls -al workout_tracer_api || true",
                "cd workout_tracer_cdk",
                "npm ci",
              ],
            },
            pre_build: {
              commands: ["npm install -g aws-cdk", "npx tsc"],
            },
            build: {
              commands: [
                // Deploy all Staging stacks in one go
                "cdk deploy $(cdk list | grep 'Staging') --require-approval never",
              ],
            },
          },
        }),
        role: cdkPipelineRole,
      },
    );

    // Prod Deploy Project: cdk deploy for all prod stacks in one command
    const prodDeployProject = new codebuild.PipelineProject(
      this,
      "WorkoutTracer-ProdDeployProject",
      {
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          privileged: true,
          environmentVariables: {
            GITHUB_TOKEN: {
              type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
              value: "GithubToken:GITHUB_TOKEN",
            },
            CICD: { value: "true" },
            CDK_ENV_CONFIG: {
              type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
              value: "workout_tracer/cdk.env",
            },
          },
        },
        logging: {
          cloudWatch: {
            logGroup: logs.LogGroup.fromLogGroupName(
              this,
              "ProdProjectLogGroup",
              "/aws/codebuild/WorkoutTracer-Pipeline",
            ),
          },
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: "0.2",
          phases: {
            install: {
              commands: [
                "ls -al workout_tracer_api || true",
                "cd workout_tracer_cdk",
                "npm ci",
              ],
            },
            pre_build: {
              commands: ["npm install -g aws-cdk", "npx tsc"],
            },
            build: {
              commands: [
                // Deploy all Prod stacks in one go
                "cdk list | grep 'Prod' | xargs -n 1 cdk deploy --require-approval never",
              ],
            },
          },
        }),
        role: cdkPipelineRole,
      },
    );

    // Remove any addToRolePolicy or addManagedPolicy calls for these projects,
    // as the shared role already has AdministratorAccess.

    // Create a deployment bucket for pipeline artifacts and logs
    const deploymentBucket = new s3.Bucket(
      this,
      "WorkoutTracerPipelineBucket",
      {
        bucketName: "workouttracer-pipeline-artifacts-" + this.account,
        removalPolicy: RemovalPolicy.DESTROY, // or RETAIN for production
        autoDeleteObjects: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
      },
    );

    // Define the pipeline and specify the artifact bucket
    const pipeline = new codepipeline.Pipeline(this, "WorkoutTracer-Pipeline", {
      pipelineName: "WorkoutTracerPipeline",
      artifactBucket: deploymentBucket,
    });

    // Source stage (only one repo can be used as a CodePipeline source action)
    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: "GitHub_Source",
      owner: "mremigio331",
      repo: "workout_tracer_cdk",
      oauthToken: githubToken.secretValueFromJson("GITHUB_TOKEN"),
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

    // CloudWatch Alarms for failed deployments
    // Staging
    const stagingAlarm = new cloudwatch.Alarm(
      this,
      "StagingPipelineFailedAlarm",
      {
        alarmName: "WorkoutTracer-Staging-Deploy-Failed",
        metric: new cloudwatch.Metric({
          namespace: "AWS/CodePipeline",
          metricName: "FailedActions",
          dimensionsMap: {
            PipelineName: "WorkoutTracerPipeline",
            StageName: "WorkoutTracer-Staging",
          },
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    stagingAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    // Prod
    const prodAlarm = new cloudwatch.Alarm(this, "ProdPipelineFailedAlarm", {
      alarmName: "WorkoutTracer-Prod-Deploy-Failed",
      metric: new cloudwatch.Metric({
        namespace: "AWS/CodePipeline",
        metricName: "FailedActions",
        dimensionsMap: {
          PipelineName: "WorkoutTracerPipeline",
          StageName: "WorkoutTracer-Prod",
        },
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    prodAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    // CloudWatch Alarms for failed builds (CodeBuild project level)
    // Build Project alarm (covers build failures for both Staging and Prod)
    const buildAlarm = new cloudwatch.Alarm(this, "BuildProjectFailedAlarm", {
      alarmName: "WorkoutTracer-BuildProject-FailedBuilds",
      metric: new cloudwatch.Metric({
        namespace: "AWS/CodeBuild",
        metricName: "FailedBuilds",
        dimensionsMap: {
          ProjectName: buildProject.projectName,
        },
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    buildAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    // Staging Deploy Project alarm
    const stagingDeployAlarm = new cloudwatch.Alarm(
      this,
      "StagingDeployProjectFailedAlarm",
      {
        alarmName: "WorkoutTracer-StagingDeployProject-FailedBuilds",
        metric: new cloudwatch.Metric({
          namespace: "AWS/CodeBuild",
          metricName: "FailedBuilds",
          dimensionsMap: {
            ProjectName: stagingDeployProject.projectName,
          },
          statistic: "Sum",
          period: Duration.minutes(30),
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        datapointsToAlarm: 1,
        actionsEnabled: true,
      },
    );
    stagingDeployAlarm.addAlarmAction(
      new cloudwatch_actions.SnsAction(alarmTopic),
    );

    // Prod Deploy Project alarm
    const prodDeployAlarm = new cloudwatch.Alarm(
      this,
      "ProdDeployProjectFailedAlarm",
      {
        alarmName: "WorkoutTracer-ProdDeployProject-FailedBuilds",
        metric: new cloudwatch.Metric({
          namespace: "AWS/CodeBuild",
          metricName: "FailedBuilds",
          dimensionsMap: {
            ProjectName: prodDeployProject.projectName,
          },
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    prodDeployAlarm.addAlarmAction(
      new cloudwatch_actions.SnsAction(alarmTopic),
    );

    // CloudWatch Alarm for build stage (pipeline-level, not CodeBuild project)
    const buildStageAlarm = new cloudwatch.Alarm(
      this,
      "BuildStageFailedAlarm",
      {
        alarmName: "WorkoutTracer-Build-Stage-Failed",
        metric: new cloudwatch.Metric({
          namespace: "AWS/CodePipeline",
          metricName: "FailedActions",
          dimensionsMap: {
            PipelineName: "WorkoutTracerPipeline",
            StageName: "WorkoutTracer-Build",
          },
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    buildStageAlarm.addAlarmAction(
      new cloudwatch_actions.SnsAction(alarmTopic),
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

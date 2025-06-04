import { Stack, aws_codebuild as codebuild, aws_iam as iam, aws_logs as logs, RemovalPolicy, Duration } from "aws-cdk-lib";
import * as path from "path";

export function createBuildProject(scope: Stack, role: iam.IRole) {
  return new codebuild.PipelineProject(
    scope,
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
          logGroup: new logs.LogGroup(scope, "BuildProjectLogGroup", {
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
              "ls -al",
              "cd ../workout_tracer_api || cd workout_tracer_api",
              "ls -al",
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
      role,
    },
  );
}

export function createStagingDeployProject(scope: Stack, role: iam.IRole) {
  const stackToDeploy = ['DatabaseStack', 'AuthStack', 'ApiStack', 'ApiDnsStack'];
  return new codebuild.PipelineProject(
    scope,
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
            scope,
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
              `cdk deploy ${stackToDeploy.map(stack => `WorkoutTracer-${stack}-Staging`).join(' ')} --require-approval never`,
            ],
          },
        },
      }),
      role,
    },
  );
}

export function createProdDeployProject(scope: Stack, role: iam.IRole) {
  const stackToDeploy = ['DatabaseStack', 'AuthStack', 'ApiStack', 'ApiDnsStack'];
  return new codebuild.PipelineProject(
    scope,
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
            scope,
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
              `cdk deploy ${stackToDeploy.map(stack => `WorkoutTracer-${stack}-Prod`).join(' ')} --require-approval never`,
            ],
          },
        },
      }),
      role,
    },
  );
}

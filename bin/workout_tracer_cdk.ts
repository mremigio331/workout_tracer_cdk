#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { STAGES } from "../lib/constatns";
import { DatabaseStack } from "../lib/stacks/database-stack";
import { AuthStack } from "../lib/stacks/auth-stack";
import { WebsiteStack } from "../lib/stacks/website-stack";
import { ApiStack } from "../lib/stacks/api-stack";
import { ApiDnsStack } from "../lib/stacks/api-dns-stack";
import * as fs from "fs";
import * as path from "path";
import { PipelineStack } from "../lib/stacks/pipeline-stack";
import { SecretsManager } from "aws-sdk";

async function getEnvConfig() {
  // Prefer a custom environment variable if set (set this in CodeBuild/CodePipeline environment)
  const isCICD = !!process.env.CICD || !!process.env.CODEBUILD_BUILD_ID || !!process.env.CODEPIPELINE_EXECUTION_ID || !!process.env.CODEDEPLOY_DEPLOYMENT_ID || !!process.env.USE_SECRETS_MANAGER;
  console.log(
    `[CDK ENV DETECT] CICD: ${process.env.CICD}, CODEBUILD_BUILD_ID: ${process.env.CODEBUILD_BUILD_ID}, CODEPIPELINE_EXECUTION_ID: ${process.env.CODEPIPELINE_EXECUTION_ID}, CODEDEPLOY_DEPLOYMENT_ID: ${process.env.CODEDEPLOY_DEPLOYMENT_ID}, USE_SECRETS_MANAGER: ${process.env.USE_SECRETS_MANAGER}, isCICD: ${isCICD}`
  );
  if (isCICD) {
    const secretsManager = new SecretsManager({ region: "us-west-2" });
    const secret = await secretsManager
      .getSecretValue({ SecretId: "workout_tracer/cdk.env" })
      .promise();
    if (!secret.SecretString) throw new Error("SecretString is empty");
    return JSON.parse(secret.SecretString);
  } else {
    // Local fallback
    const envFilePath = path.resolve(__dirname, "../cdk.env.json");
    console.log(`[CDK ENV DETECT] Using local env file: ${envFilePath}`);
    const envFileContent = fs.readFileSync(envFilePath, "utf-8");
    return JSON.parse(envFileContent);
  }
}

async function main() {
  const app = new cdk.App();
  const awsEnv = { region: "us-west-2" };
  const envConfig = await getEnvConfig();

  new PipelineStack(app, "WorkoutTracer-PipelineStack", {
    env: awsEnv,
  });

  for (const stage of Object.keys(envConfig)) {
    const config = envConfig[stage];

    const {
      hostedZoneId,
      websiteDomainName,
      apiDomainName,
      callbackUrls,
      websiteCertificateArn,
      apiCertificateArn,
    } = config;

    // Database stack
    const databaseStack = new DatabaseStack(
      app,
      `WorkoutTracer-DatabaseStack-${stage}`,
      {
        env: awsEnv,
        stage,
      },
    );

    // Auth stack
    const authStack = new AuthStack(app, `WorkoutTracer-AuthStack-${stage}`, {
      env: awsEnv,
      stage,
      callbackUrls,
      userTable: databaseStack.table,
    });

    // Website stack
    new WebsiteStack(app, `WorkoutTracer-WebsiteStack-${stage}`, {
      env: awsEnv,
      stage,
      domainName: websiteDomainName,
      certificateArn: websiteCertificateArn,
      hostedZoneId: hostedZoneId,
    });

    // API stack
    const api = new ApiStack(app, `WorkoutTracer-ApiStack-${stage}`, {
      env: awsEnv,
      stage,
      userPool: authStack.userPool,
      userPoolClient: authStack.userPoolClient,
    });

    // API DNS stack
    new ApiDnsStack(app, `WorkoutTracer-ApiDnsStack-${stage}`, {
      env: awsEnv,
      stage,
      rootDomainName: websiteDomainName,
      apiDomainName: apiDomainName,
      hostedZoneId: hostedZoneId,
      api: api.api,
      certificateArn: apiCertificateArn,
    });
  }
}

main();

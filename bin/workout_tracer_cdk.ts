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

const envFilePath = path.resolve(__dirname, "../cdk.env.json");
const envFileContent = fs.readFileSync(envFilePath, "utf-8");
const envConfig = JSON.parse(envFileContent);

const app = new cdk.App();
const awsEnv = { region: "us-west-2" };

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

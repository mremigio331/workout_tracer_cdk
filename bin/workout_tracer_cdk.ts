#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { DatabaseStack } from "../lib/stacks/database-stack";
import { AuthStack } from "../lib/stacks/auth-stack";
import { WebsiteStack } from "../lib/stacks/website-stack";
import { ApiStack } from "../lib/stacks/api-stack";
import { ApiDnsStack } from "../lib/stacks/api-dns-stack";

const app = new cdk.App();
const callbackUrls = app.node.tryGetContext("callbackUrls") as string[];
const domainName = app.node.tryGetContext("domainName") as string;
const hostedZoneId = app.node.tryGetContext("hostedZoneId") as string;
const websiteCertificateArn = app.node.tryGetContext(
  "websiteCertificateArn",
) as string;
const apiCertificateArn = app.node.tryGetContext("apiCertificateArn") as string;

const env = { region: "us-west-2" };

const databaseStack = new DatabaseStack(app, "WorkoutTracer-DatabaseStack", {
  env,
});

const authStack = new AuthStack(app, "WorkoutTracer-AuthStack", {
  env,
  callbackUrls: callbackUrls,
  userTable: databaseStack.table,
});

new WebsiteStack(app, "WorkoutTracer-WebsiteStack", {
  env,
  domainName: domainName,
  certificateArn: websiteCertificateArn,
  hostedZoneId: hostedZoneId,
});

const api = new ApiStack(app, "WorkoutTracer-ApiStack", {
  env,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
});

new ApiDnsStack(app, "WorkoutTracer-ApiDnsStack", {
  env,
  domainName: domainName,
  hostedZoneId: hostedZoneId,
  api: api.api,
  certificateArn: apiCertificateArn,
});

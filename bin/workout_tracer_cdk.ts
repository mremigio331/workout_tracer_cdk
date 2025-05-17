#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { DatabaseStack } from "../lib/stacks/database-stack";
import { AuthStack } from "../lib/stacks/auth-stack";
import { WebsiteStack } from "../lib/stacks/website-stack";
import { ApiStack } from "../lib/stacks/api-stack";

const app = new cdk.App();
const callbackUrls = app.node.tryGetContext("callbackUrls") as string[];
const domainName = app.node.tryGetContext("domainName") as string;
const hostedZoneId = app.node.tryGetContext("hostedZoneId") as string;
const certificateArn = app.node.tryGetContext("certificateArn") as string;

const env = { region: "us-west-2" };

const databaseStack = new DatabaseStack(app, "WorkoutTracer-DatabaseStack", {
  env,
});

const authStack = new AuthStack(app, "WorkoutTracer-AuthStack", {
  env,
  configs: {
    callbackUrls: callbackUrls,
  },
  userTable: databaseStack.table,
});

new WebsiteStack(app, "WorkoutTracer-WebsiteStack", {
  env,
  domainName: domainName,
  certificateArn: certificateArn,
  hostedZoneId: hostedZoneId,
});

new ApiStack(app, "WorkoutTracer-ApiStack", {
  env,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
});

#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { AuthStack } from '../lib/stacks/auth-stack';

const app = new cdk.App();
const callbackUrls = app.node.tryGetContext('callbackUrls') as string[];

const env = { region: 'us-west-2' };

const databaseStack = new DatabaseStack(app, 'WorkoutTracer-DatabaseStack', {
  env,
});

new AuthStack(app, 'WorkoutTracer-AuthStack', {
  env,
  configs: {
    callbackUrls: callbackUrls,
  },
  userTable: databaseStack.table,
});
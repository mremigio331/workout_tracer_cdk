# WorkoutTracer CDK TypeScript Project

This repository contains the AWS CDK infrastructure code for the WorkoutTracer application, written in TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Project Structure

- **bin/**: Entry point for the CDK app (`workout_tracer_cdk.ts`)
- **lib/**: CDK stack definitions (API, Auth, Website, Database, DNS, Pipeline)

## Environments

This project supports multiple deployment stages (e.g., Staging, Prod). Environment configuration is managed in `cdk.env.json`.

## Stacks

- **DatabaseStack**: DynamoDB and related resources
- **AuthStack**: Cognito User Pool, Identity Pool, and triggers
- **WebsiteStack**: S3 static site, CloudFront, Route53, and deployment
- **ApiStack**: Lambda, API Gateway, and logging
- **ApiDnsStack**: Custom domain and DNS for API Gateway

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy all stacks to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

## Deploying a Specific Stage

To deploy only a specific stage (e.g., Staging):

```sh
npx cdk deploy WorkoutTracer-DatabaseStack-Staging WorkoutTracer-AuthStack-Staging WorkoutTracer-WebsiteStack-Staging WorkoutTracer-ApiStack-Staging WorkoutTracer-ApiDnsStack-Staging
```

## Environment Configuration

Edit `cdk.env.json` to update domain names, certificate ARNs, callback URLs, and other environment-specific settings.

## Notes

- All resource names are suffixed with the deployment stage (e.g., `WorkoutTracer-ApiStack-Staging`).
- S3 bucket names and other resources requiring lowercase use `.toLowerCase()` on the stage name.
- The pipeline can be extended to support CI/CD with GitHub and CodePipeline.

## Formatting
```
npx prettier --write "**/*.ts"   
```
---

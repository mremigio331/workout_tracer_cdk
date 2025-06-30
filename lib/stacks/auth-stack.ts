import {
  Stack,
  StackProps,
  RemovalPolicy,
  CfnOutput,
  Duration,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as path from "path";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import { addAuthMonitoring } from "../monitoring/authMonitoring";

interface AuthStackProps extends StackProps {
  callbackUrls: string[];
  stage: string;
  userTable: dynamodb.ITable;
  escalationEmail: string;
  escalationNumber: string;
}

export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  public readonly identityPool: cognito.CfnIdentityPool;
  

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { callbackUrls, userTable, stage, escalationEmail, escalationNumber } = props;

    const userAddedTopic = new sns.Topic(this, `UserAddedTopic-${stage}`, {
      topicName: `WorkoutTracer-UserAddedTopic-${stage}`,
      displayName: `WorkoutTracer User Added Topic (${stage})`,
    });

    userAddedTopic.addSubscription(new subs.EmailSubscription(escalationEmail));
    userAddedTopic.addSubscription(new subs.SmsSubscription(escalationNumber));

    const layer = new lambda.LayerVersion(
      this,
      `WorkoutTracer-CognitoLambdaLayer-${stage}`,
      {
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../workout_tracer_api/lambda_layer.zip"),
        ),
        compatibleRuntimes: [lambda.Runtime.PYTHON_3_11],
        description: "WorkoutTracer Lambda layer with dependencies",
      },
    );

    const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      `WorkoutTracer-PowertoolsLayer-${stage}`,
      `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV2:53`,
    );

    const userEventLogger = new lambda.Function(
      this,
      `WorkoutTracer-UserEventLogger-${stage}`,
      {
        functionName: `WorkoutTracer-CognitoUserEventLogger-${stage}`,
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: "lambdas.cognito_user_creator.handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../workout_tracer_api"),
        ),
        tracing: lambda.Tracing.ACTIVE, // Enable X-Ray tracing for Lambda
        timeout: Duration.seconds(10),
        layers: [layer, powertoolsLayer],
        environment: {
          TABLE_NAME: userTable.tableName,
          POWERTOOLS_LOG_LEVEL: "INFO",
          USER_ADDED_TOPIC_ARN: userAddedTopic.topicArn, // Pass topic ARN to Lambda
        },
      },
    );

    // Grant Lambda permission to publish to SNS topic
    userAddedTopic.grantPublish(userEventLogger);

    // Create a log group for the Lambda (explicitly, so we can alarm on it)
    const logGroup = new logs.LogGroup(
      this,
      `UserEventLoggerLogGroup-${stage}`,
      {
        logGroupName: `/aws/lambda/WorkoutTracer-CognitoUserEventLogger-${stage}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      },
    );

    userTable.grantReadWriteData(userEventLogger);
    userTable.grantWriteData(userEventLogger);

    // CloudWatch Metric Filter and Alarm for Lambda errors
    addAuthMonitoring(this, logGroup, stage);

    this.userPool = new cognito.UserPool(
      this,
      `WorkoutTracer-UserPool-${stage}`,
      {
        userPoolName: `WorkoutTracer-UserPool-${stage}`,
        selfSignUpEnabled: true,
        signInAliases: {
          email: true,
        },
        standardAttributes: {
          fullname: { required: true, mutable: true },
          email: { required: true, mutable: false },
        },
        passwordPolicy: {
          minLength: 8,
          requireLowercase: true,
          requireUppercase: true,
          requireDigits: true,
          requireSymbols: false,
        },
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        removalPolicy: RemovalPolicy.DESTROY,
      },
    );

    this.userPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      userEventLogger,
    );
    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION,
      userEventLogger,
    );

    this.userPoolClient = new cognito.UserPoolClient(
      this,
      `WorkoutTracer-UserPoolClient-${stage}`,
      {
        userPool: this.userPool,
        generateSecret: false,
        oAuth: {
          flows: {
            authorizationCodeGrant: true,
          },
          scopes: [
            cognito.OAuthScope.EMAIL,
            cognito.OAuthScope.OPENID,
            cognito.OAuthScope.PROFILE,
          ],
          callbackUrls,
          logoutUrls: callbackUrls,
        },
        accessTokenValidity: Duration.hours(24),
        idTokenValidity: Duration.hours(24),     
        refreshTokenValidity: Duration.days(7),
      },
    );

    this.userPoolDomain = new cognito.UserPoolDomain(
      this,
      `WorkoutTracer-CognitoDomain-${stage}`,
      {
        userPool: this.userPool,
        cognitoDomain: {
          domainPrefix: `workouttracer-${stage.toLowerCase()}`,
        },
      },
    );

    // Federated Identity Pool
    this.identityPool = new cognito.CfnIdentityPool(
      this,
      `WorkoutTracer-IdentityPool-${stage}`,
      {
        allowUnauthenticatedIdentities: false,
        cognitoIdentityProviders: [
          {
            clientId: this.userPoolClient.userPoolClientId,
            providerName: this.userPool.userPoolProviderName,
          },
        ],
      },
    );

    new CfnOutput(this, `WorkoutTracer-UserPoolId-${stage}`, {
      value: this.userPool.userPoolId,
    });

    new CfnOutput(this, `WorkoutTracer-UserPoolClientId-${stage}`, {
      value: this.userPoolClient.userPoolClientId,
    });

    new CfnOutput(this, `WorkoutTracer-UserPoolDomain-${stage}`, {
      value: `${this.userPoolDomain.domainName}.auth.${Stack.of(this).region}.amazoncognito.com`,
    });

    new CfnOutput(this, `WorkoutTracer-IdentityPoolId-${stage}`, {
      value: this.identityPool.ref,
    });

    new CfnOutput(this, `WorkoutTracer-UserPoolArn-${stage}`, {
      value: this.userPool.userPoolArn,
      exportName: `WorkoutTracer-AuthStack-UserPoolArn-${stage}`,
    });
  }
}

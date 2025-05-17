import {
  Stack,
  StackProps,
  RemovalPolicy,
  CfnOutput,
  Duration,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'path';

interface AuthStackProps extends StackProps {
  configs: {
    callbackUrls: string[];
  };
  userTable: dynamodb.ITable;
}

export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { callbackUrls } = props.configs;

    // ✅ Use official Powertools Lambda Layer for Python
    const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'PowertoolsLayer',
      `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV2:53`
    );

    // ✅ Lambda function with Powertools layer
    const userEventLogger = new lambda.Function(this, 'UserEventLogger', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../../lambda/user-event-logger')
      ),
      timeout: Duration.seconds(10),
      logRetention: 7,
      layers: [powertoolsLayer],
      environment: {
        TABLE_NAME: props.userTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'user-signup',
        POWERTOOLS_LOG_LEVEL: 'INFO',
      },
    });

    // ✅ Allow Lambda to write to DynamoDB table
    props.userTable.grantWriteData(userEventLogger);

    // ✅ User Pool
    this.userPool = new cognito.UserPool(this, 'WorkoutTracerUserPool', {
      userPoolName: 'workout-tracer-website-user-pool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      standardAttributes: {
        fullname: { required: true, mutable: true },
        nickname: { required: true, mutable: true },
        preferredUsername: { required: true, mutable: true },
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
    });

    // ✅ Attach Lambda triggers
    this.userPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      userEventLogger
    );
    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION,
      userEventLogger
    );

    // ✅ App Client
    this.userPoolClient = new cognito.UserPoolClient(
      this,
      'WorkoutTracerUserPoolClient',
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
            cognito.OAuthScope.PHONE,
            cognito.OAuthScope.PROFILE,
            cognito.OAuthScope.COGNITO_ADMIN,
          ],
          callbackUrls,
          logoutUrls: callbackUrls,
        },
      }
    );

    // ✅ Cognito Domain
    this.userPoolDomain = new cognito.UserPoolDomain(this, 'CognitoDomain', {
      userPool: this.userPool,
      cognitoDomain: {
        domainPrefix: 'workouttracer',
      },
    });

    // ✅ Outputs
    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
    });

    new CfnOutput(this, 'UserPoolDomain', {
      value: `${this.userPoolDomain.domainName}.auth.${Stack.of(this).region}.amazoncognito.com`,
    });
  }
}

import {
  Stack,
  StackProps,
  Duration,
  aws_logs as logs,
  aws_lambda as lambda,
  aws_dynamodb as dynamodb,
  aws_sqs as sqs,
  aws_kms as kms,
  aws_events as events,
  aws_cognito as cognito,
  aws_events_targets as targets,
  aws_cloudwatch as cloudwatch,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import * as path from "path";

interface WorkoutTracerStravaStackProps extends StackProps {
  stage: string;
  userTable: dynamodb.ITable;
  kmsKey: kms.IKey;
  userPool: cognito.UserPool;
}

export class WorkoutTracerStravaStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: WorkoutTracerStravaStackProps,
  ) {
    super(scope, id, props);

    const { stage, userTable, kmsKey, userPool } = props;

    const dlq = new sqs.Queue(
      this,
      `WorkoutTracer-RateLimitedBatcherDLQ-${stage}`,
      {
        queueName: `WorkoutTracer-RateLimitedBatcherDLQ-${stage}`,
        retentionPeriod: Duration.days(14),
      },
    );

    const queue = new sqs.Queue(
      this,
      `WorkoutTracer-RateLimitedBatcherQueue-${stage}`,
      {
        queueName: `WorkoutTracer-RateLimitedBatcherQueue-${stage}`,
        visibilityTimeout: Duration.seconds(1800),
        retentionPeriod: Duration.days(7),
        deadLetterQueue: {
          maxReceiveCount: 5,
          queue: dlq,
        },
      },
    );

    const layer = new lambda.LayerVersion(
      this,
      `WorkoutTracer-ApiLayer-${stage}`,
      {
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../workout_tracer_api/lambda_layer.zip"),
        ),
        compatibleRuntimes: [lambda.Runtime.PYTHON_3_11],
        description: `WorkoutTracer-ApiLayer-${stage}`,
      },
    );

    const heavyLayer = new lambda.LayerVersion(
      this,
      `WorkoutTracer-HeavyLayer-${stage}`,
      {
        code: lambda.Code.fromAsset(
          path.join(
            __dirname,
            "../../../workout_tracer_api/lambda_layer_heavy.zip",
          ),
        ),
        compatibleRuntimes: [lambda.Runtime.PYTHON_3_11],
        description: `WorkoutTracer-HeavyLayer-${stage} (numpy, shapely, lxml)`,
      },
    );

    const liteLayer = new lambda.LayerVersion(
      this,
      `WorkoutTracer-LiteLayer-${stage}`,
      {
        code: lambda.Code.fromAsset(
          path.join(
            __dirname,
            "../../../workout_tracer_api/lambda_layer_lite.zip",
          ),
        ),
        compatibleRuntimes: [lambda.Runtime.PYTHON_3_11],
        description: `WorkoutTracer-LiteLayer-${stage} (powertools, pydantic, pytz)`,
      },
    );

    const enrichWorkoutLocationsLogGroup = new logs.LogGroup(
      this,
      `WorkoutTracer-EnrichWorkoutLocationsLogGroup-${stage}`,
      {
        logGroupName: `/aws/lambda/WorkoutTracer-EnrichWorkoutLocationsLambda-${stage}`,
        retention: logs.RetentionDays.ONE_MONTH,
      },
    );

    const enrichWorkoutLocationsLambda = new lambda.Function(
      this,
      `WorkoutTracer-EnrichWorkoutLocationsLambda-${stage}`,
      {
        functionName: `WorkoutTracer-EnrichWorkoutLocationsLambda-${stage}`,
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: "lambdas.enrich_workout_locations.lambda_handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../workout_tracer_api"),
          {
            exclude: [
              "**/*.ipynb",
              "**/*.kml",
              "**/*.zip",
              "**/__pycache__/**",
              "**/*.pyc",
              "notebooks/**",
              "scratch/**",
              "ops_tools/**",
              "*.sh",
            ],
          },
        ),
        layers: [liteLayer, heavyLayer],
        timeout: Duration.minutes(15),
        memorySize: 1024,
        environment: {
          TABLE_NAME: userTable.tableName,
          STAGE: stage,
        },
        description: `Enriches a workout with location badges for ${stage}`,
        logGroup: enrichWorkoutLocationsLogGroup,
      },
    );

    userTable.grantReadWriteData(enrichWorkoutLocationsLambda);

    enrichWorkoutLocationsLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [
          "arn:aws:s3:::workout-tracer-kml-files-851753231474-us-west-2-an/*",
        ],
      }),
    );
    enrichWorkoutLocationsLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [
          "arn:aws:s3:::workout-tracer-kml-files-851753231474-us-west-2-an",
        ],
      }),
    );

    const enrichDlq = new sqs.Queue(
      this,
      `WorkoutTracer-EnrichWorkoutLocationsDLQ-${stage}`,
      {
        queueName: `WorkoutTracer-EnrichWorkoutLocationsDLQ-${stage}.fifo`,
        retentionPeriod: Duration.days(14),
        fifo: true,
      },
    );

    const enrichQueue = new sqs.Queue(
      this,
      `WorkoutTracer-EnrichWorkoutLocationsQueue-${stage}`,
      {
        queueName: `WorkoutTracer-EnrichWorkoutLocationsQueue-${stage}.fifo`,
        visibilityTimeout: Duration.minutes(15),
        retentionPeriod: Duration.days(7),
        fifo: true,
        contentBasedDeduplication: true,
        deadLetterQueue: {
          maxReceiveCount: 3,
          queue: enrichDlq,
        },
      },
    );

    new cloudwatch.Alarm(
      this,
      `WorkoutTracer-EnrichWorkoutLocationsDLQAlarm-${stage}`,
      {
        alarmName: `WorkoutTracer-EnrichWorkoutLocationsDLQAlarm-${stage}`,
        metric: enrichDlq.metricApproximateNumberOfMessagesVisible(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: `Enrichment DLQ has messages — investigate failed enrichments for ${stage}`,
      },
    );

    enrichWorkoutLocationsLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(enrichQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    const batchUpdateLogGroup = new logs.LogGroup(
      this,
      `WorkoutTracer-BatchUpdateWorkoutsLogGroup-${stage}`,
      {
        logGroupName: `/aws/lambda/WorkoutTracer-BatchUpdateWorkoutsLambda-${stage}`,
        retention: logs.RetentionDays.ONE_MONTH,
      },
    );

    const batchUpdateLambda = new lambda.Function(
      this,
      `WorkoutTracer-BatchUpdateWorkoutsLambda-${stage}`,
      {
        functionName: `WorkoutTracer-BatchUpdateWorkoutsLambda-${stage}`,
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: "lambdas.batch_update_workouts.lambda_handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../workout_tracer_api"),
          {
            exclude: [
              "**/*.ipynb",
              "**/*.kml",
              "**/*.zip",
              "**/__pycache__/**",
              "**/*.pyc",
              "notebooks/**",
              "scratch/**",
              "ops_tools/**",
              "*.sh",
            ],
          },
        ),
        layers: [layer],
        timeout: Duration.minutes(15),
        environment: {
          KMS_KEY_ARN: kmsKey.keyArn,
          SQS_QUEUE_URL: queue.queueUrl,
          DLQ_URL: dlq.queueUrl,
          TABLE_NAME: userTable.tableName,
          STAGE: stage,
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          ENRICH_SQS_QUEUE_URL: enrichQueue.queueUrl,
        },
        description: `Processes Strava workout batch updates from SQS for stage ${stage}`,
        logGroup: batchUpdateLogGroup,
      },
    );

    userTable.grantReadWriteData(batchUpdateLambda);
    queue.grantConsumeMessages(batchUpdateLambda);
    dlq.grantSendMessages(batchUpdateLambda);
    kmsKey.grantEncryptDecrypt(batchUpdateLambda);
    enrichQueue.grantSendMessages(batchUpdateLambda);

    batchUpdateLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:StravaKeys*`,
        ],
      }),
    );

    batchUpdateLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["*"],
      }),
    );

    batchUpdateLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      }),
    );

    // Add Cognito permissions for batchUpdateLambda
    batchUpdateLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cognito-idp:AdminGetUser"],
        resources: [userPool.userPoolArn],
      }),
    );

    const rule = new events.Rule(
      this,
      `WorkoutTracer-BatchUpdateScheduleRule-${stage}`,
      {
        ruleName: `WorkoutTracer-BatchUpdateScheduleRule-${stage}`,
        schedule: events.Schedule.rate(Duration.minutes(30)),
        description: `Invoke batch update lambda every 30 minutes for ${stage}`,
        enabled: true,
      },
    );
    rule.addTarget(new targets.LambdaFunction(batchUpdateLambda));

    const onboardingLogGroup = new logs.LogGroup(
      this,
      `WorkoutTracer-StravaOnboardingLogGroup-${stage}`,
      {
        logGroupName: `/aws/lambda/WorkoutTracer-StravaOnboardingLambda-${stage}`,
        retention: logs.RetentionDays.ONE_MONTH,
      },
    );

    // Lambda for onboarding_v2
    const stravaOnboardingV2Lambda = new lambda.Function(
      this,
      `WorkoutTracer-StravaOnboardingLambdaV2-${stage}`,
      {
        functionName: `WorkoutTracer-StravaOnboardingLambdaV2-${stage}`,
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: "lambdas.strava_onboarding_v2.lambda_handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../workout_tracer_api"),
          {
            exclude: [
              "**/*.ipynb",
              "**/*.kml",
              "**/*.zip",
              "**/__pycache__/**",
              "**/*.pyc",
              "notebooks/**",
              "scratch/**",
              "ops_tools/**",
              "*.sh",
            ],
          },
        ),
        layers: [layer],
        timeout: Duration.minutes(15),
        environment: {
          KMS_KEY_ARN: kmsKey.keyArn,
          SQS_QUEUE_URL: queue.queueUrl,
          DLQ_URL: dlq.queueUrl,
          TABLE_NAME: userTable.tableName,
          STAGE: stage,
          ENRICH_SQS_QUEUE_URL: enrichQueue.queueUrl,
        },
        description: `Strava onboarding v2 processor for stage ${stage}`,
        logGroup: onboardingLogGroup,
      },
    );

    userTable.grantReadWriteData(stravaOnboardingV2Lambda);
    queue.grantConsumeMessages(stravaOnboardingV2Lambda);
    dlq.grantSendMessages(stravaOnboardingV2Lambda);
    kmsKey.grantEncryptDecrypt(stravaOnboardingV2Lambda);
    enrichQueue.grantSendMessages(stravaOnboardingV2Lambda);

    stravaOnboardingV2Lambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
          "sqs:ChangeMessageVisibility",
        ],
        resources: [queue.queueArn, dlq.queueArn],
      }),
    );

    stravaOnboardingV2Lambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:StravaKeys*`,
        ],
      }),
    );

    stravaOnboardingV2Lambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["*"],
      }),
    );

    stravaOnboardingV2Lambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      }),
    );

    const backfillLocationBadgesLogGroup = new logs.LogGroup(
      this,
      `WorkoutTracer-BackfillLocationBadgesLogGroup-${stage}`,
      {
        logGroupName: `/aws/lambda/WorkoutTracer-BackfillLocationBadgesLambda-${stage}`,
        retention: logs.RetentionDays.ONE_MONTH,
      },
    );

    const backfillLocationBadgesLambda = new lambda.Function(
      this,
      `WorkoutTracer-BackfillLocationBadgesLambda-${stage}`,
      {
        functionName: `WorkoutTracer-BackfillLocationBadgesLambda-${stage}`,
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: "lambdas.backfill_location_badges.lambda_handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../../workout_tracer_api"),
          {
            exclude: [
              "**/*.ipynb",
              "**/*.kml",
              "**/*.zip",
              "**/__pycache__/**",
              "**/*.pyc",
              "notebooks/**",
              "scratch/**",
              "ops_tools/**",
              "*.sh",
            ],
          },
        ),
        layers: [layer],
        timeout: Duration.minutes(15),
        environment: {
          TABLE_NAME: userTable.tableName,
          ENRICH_SQS_QUEUE_URL: enrichQueue.queueUrl,
          STAGE: stage,
        },
        description: `Enqueues all workout IDs for a user to backfill location badges for ${stage}`,
        logGroup: backfillLocationBadgesLogGroup,
      },
    );

    userTable.grantReadData(backfillLocationBadgesLambda);
    enrichQueue.grantSendMessages(backfillLocationBadgesLambda);

    backfillLocationBadgesLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [
          "arn:aws:s3:::workout-tracer-kml-files-851753231474-us-west-2-an/*",
        ],
      }),
    );
    backfillLocationBadgesLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [
          "arn:aws:s3:::workout-tracer-kml-files-851753231474-us-west-2-an",
        ],
      }),
    );

    // Avoid circular dependency by using the function ARN string directly
    stravaOnboardingV2Lambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:WorkoutTracer-StravaOnboardingLambdaV2-${stage}`,
        ],
      }),
    );
  }
}

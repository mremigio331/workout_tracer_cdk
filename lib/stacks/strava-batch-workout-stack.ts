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
  aws_events_targets as targets,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "path";

interface WorkoutTracerRateLimitedBatcherStackProps extends StackProps {
  stage: string;
  userTable: dynamodb.ITable;
  kmsKey: kms.IKey;
}

export class WorkoutTracerRateLimitedBatcherStack extends Stack {
  constructor(scope: Construct, id: string, props: WorkoutTracerRateLimitedBatcherStackProps) {
    super(scope, id, props);

    const { stage, userTable, kmsKey } = props;

    const dlq = new sqs.Queue(this, `WorkoutTracer-RateLimitedBatcherDLQ-${stage}`, {
      queueName: `WorkoutTracer-RateLimitedBatcherDLQ-${stage}`,
      retentionPeriod: Duration.days(14),
    });

    const queue = new sqs.Queue(this, `WorkoutTracer-RateLimitedBatcherQueue-${stage}`, {
      queueName: `WorkoutTracer-RateLimitedBatcherQueue-${stage}`,
      visibilityTimeout: Duration.seconds(1800),
      retentionPeriod: Duration.days(7),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: dlq,
      },
    });

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

    const batchUpdateLogGroup = new logs.LogGroup(this, `WorkoutTracer-BatchUpdateWorkoutsLogGroup-${stage}`, {
      logGroupName: `/aws/lambda/WorkoutTracer-BatchUpdateWorkoutsLambda-${stage}`,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const batchUpdateLambda = new lambda.Function(this, `WorkoutTracer-BatchUpdateWorkoutsLambda-${stage}`, {
      functionName: `WorkoutTracer-BatchUpdateWorkoutsLambda-${stage}`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: "lambdas.batch_update_workouts.lambda_handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../../workout_tracer_api")
      ),
      timeout: Duration.minutes(15),
      layers: [layer],
      environment: {
        KMS_KEY_ARN: kmsKey.keyArn,
        SQS_QUEUE_URL: queue.queueUrl,
        DLQ_URL: dlq.queueUrl,
        TABLE_NAME: userTable.tableName,
        STAGE: stage,
      },
      description: `Processes Strava workout batch updates from SQS for stage ${stage}`,
      logGroup: batchUpdateLogGroup,
    });

    userTable.grantReadWriteData(batchUpdateLambda);
    queue.grantConsumeMessages(batchUpdateLambda);
    dlq.grantSendMessages(batchUpdateLambda);
    kmsKey.grantEncryptDecrypt(batchUpdateLambda);

    batchUpdateLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:StravaKeys*`
        ],
      })
    );

    batchUpdateLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ],
        resources: ["*"],
      })
    );

    batchUpdateLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      })
    );

    const rule = new events.Rule(this, `WorkoutTracer-BatchUpdateScheduleRule-${stage}`, {
      schedule: events.Schedule.rate(Duration.minutes(30)),
      description: `Invoke batch update lambda every 30 minutes for ${stage}`,
    });
    rule.addTarget(new targets.LambdaFunction(batchUpdateLambda));
  }
}

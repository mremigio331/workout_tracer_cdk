import { Stack, Duration, aws_cloudwatch as cloudwatch, aws_apigateway as apigw, aws_sns as sns, aws_sns_subscriptions as subs } from "aws-cdk-lib";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";

export function addApiMonitoring(
  scope: Stack,
  api: apigw.LambdaRestApi,
  stage: string,
  escalationEmail: string,
  escalationNumber: string
) {
  const apiGatewayName = `WorkoutTracer-Api-${stage}`;
  const apiStageName = api.deploymentStage.stageName;

  // Create SNS Topic for alarm notifications
  const alarmTopic = new sns.Topic(scope, `WorkoutTracer-ApiAlarmTopic-${stage}`, {
    topicName: `WorkoutTracer-ApiAlarmTopic-${stage}`,
    displayName: `WorkoutTracer API Alarm Topic (${stage})`,
  });

  // Add email and SMS subscriptions
  alarmTopic.addSubscription(new subs.EmailSubscription(escalationEmail));
  alarmTopic.addSubscription(new subs.SmsSubscription(escalationNumber));

  // 2XX metric
  const api2xxMetric = new cloudwatch.Metric({
    namespace: "AWS/ApiGateway",
    metricName: "2XXError",
    dimensionsMap: {
      ApiName: apiGatewayName,
      Stage: apiStageName,
    },
    statistic: "Sum",
    period: Duration.minutes(5),
  });

  // 4XX metric
  const api4xxMetric = new cloudwatch.Metric({
    namespace: "AWS/ApiGateway",
    metricName: "4XXError",
    dimensionsMap: {
      ApiName: apiGatewayName,
      Stage: apiStageName,
    },
    statistic: "Sum",
    period: Duration.minutes(5),
  });

  // Count metric (total requests)
  const apiCountMetric = new cloudwatch.Metric({
    namespace: "AWS/ApiGateway",
    metricName: "Count",
    dimensionsMap: {
      ApiName: apiGatewayName,
      Stage: apiStageName,
    },
    statistic: "Sum",
    period: Duration.minutes(5),
  });

  // Math expression for 4XX error rate (%)
  const api4xxRate = new cloudwatch.MathExpression({
    expression: "100 * (fourxx / total)",
    usingMetrics: {
      fourxx: api4xxMetric,
      total: apiCountMetric,
    },
    label: "4XX Error Rate (%)",
    period: Duration.minutes(5),
  });

  // Alarm for 4XX error rate > 40%
  const alarm4xx = new cloudwatch.Alarm(
    scope,
    `WorkoutTracer-Api-4XXRateAlarm-${stage}`,
    {
      alarmName: `WorkoutTracer-Api-4XXRateAlarm-${stage}`,
      metric: api4xxRate,
      threshold: 40,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: `WorkoutTracer-Api-4XXRateAlarm-${stage}: Alarm if 4XX error rate exceeds 40% on API Gateway (${stage})`,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      actionsEnabled: true,
    },
  );
  alarm4xx.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));
  alarm4xx.addOkAction(new cloudwatch_actions.SnsAction(alarmTopic));

  // 5XX metric
  const api5xxMetric = new cloudwatch.Metric({
    namespace: "AWS/ApiGateway",
    metricName: "5XXError",
    dimensionsMap: {
      ApiName: apiGatewayName,
      Stage: apiStageName,
    },
    statistic: "Sum",
    period: Duration.minutes(5),
  });

  // === Alarm for 5XX errors ===
  const alarm5xx = new cloudwatch.Alarm(
    scope,
    `WorkoutTracer-Api-5XXAlarm-${stage}`,
    {
      alarmName: `WorkoutTracer-Api-5XXAlarm-${stage}`,
      metric: api5xxMetric,
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: `WorkoutTracer-Api-5XXAlarm-${stage}: Alarm if any 5XX errors occur on API Gateway (${stage})`,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      actionsEnabled: true,
    },
  );
  alarm5xx.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));
  alarm5xx.addOkAction(new cloudwatch_actions.SnsAction(alarmTopic));
}

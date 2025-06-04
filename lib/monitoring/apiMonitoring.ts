import { Stack, Duration, aws_cloudwatch as cloudwatch, aws_apigateway as apigw } from "aws-cdk-lib";

export function addApiMonitoring(
  scope: Stack,
  api: apigw.LambdaRestApi,
  stage: string
) {
  const apiGatewayName = `WorkoutTracer-Api-${stage}`;
  const apiStageName = api.deploymentStage.stageName;

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
  new cloudwatch.Alarm(
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
    },
  );

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
  new cloudwatch.Alarm(
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
    },
  );
}

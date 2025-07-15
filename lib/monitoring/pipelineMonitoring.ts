import {
  Stack,
  Duration,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatch_actions,
  aws_sns as sns,
  aws_codepipeline as codepipeline,
  aws_codebuild as codebuild,
} from "aws-cdk-lib";

export function addPipelineMonitoring(
  scope: Stack,
  alarmTopic: sns.Topic,
  pipeline: codepipeline.Pipeline,
  buildProject: codebuild.PipelineProject,
  stagingDeployProject: codebuild.PipelineProject,
  prodDeployProject: codebuild.PipelineProject,
) {
  // CloudWatch Alarms for failed deployments
  // Staging
  const stagingAlarm = new cloudwatch.Alarm(
    scope,
    "StagingPipelineFailedAlarm",
    {
      alarmName: "WorkoutTracer-Staging-Deploy-Failed",
      metric: new cloudwatch.Metric({
        namespace: "AWS/CodePipeline",
        metricName: "FailedActions",
        dimensionsMap: {
          PipelineName: pipeline.pipelineName,
          StageName: "WorkoutTracer-Staging",
        },
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );
  stagingAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

  // Prod
  const prodAlarm = new cloudwatch.Alarm(scope, "ProdPipelineFailedAlarm", {
    alarmName: "WorkoutTracer-Prod-Deploy-Failed",
    metric: new cloudwatch.Metric({
      namespace: "AWS/CodePipeline",
      metricName: "FailedActions",
      dimensionsMap: {
        PipelineName: pipeline.pipelineName,
        StageName: "WorkoutTracer-Prod",
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    }),
    threshold: 0,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  prodAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

  // CloudWatch Alarms for failed builds (CodeBuild project level)
  // Build Project alarm (covers build failures for both Staging and Prod)
  const buildAlarm = new cloudwatch.Alarm(scope, "BuildProjectFailedAlarm", {
    alarmName: "WorkoutTracer-BuildProject-FailedBuilds",
    metric: new cloudwatch.Metric({
      namespace: "AWS/CodeBuild",
      metricName: "FailedBuilds",
      dimensionsMap: {
        ProjectName: buildProject.projectName,
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    }),
    threshold: 0,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  buildAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

  // Staging Deploy Project alarm
  const stagingDeployAlarm = new cloudwatch.Alarm(
    scope,
    "StagingDeployProjectFailedAlarm",
    {
      alarmName: "WorkoutTracer-StagingDeployProject-FailedBuilds",
      metric: new cloudwatch.Metric({
        namespace: "AWS/CodeBuild",
        metricName: "FailedBuilds",
        dimensionsMap: {
          ProjectName: stagingDeployProject.projectName,
        },
        statistic: "Sum",
        period: Duration.minutes(30),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      datapointsToAlarm: 1,
      actionsEnabled: true,
    },
  );
  stagingDeployAlarm.addAlarmAction(
    new cloudwatch_actions.SnsAction(alarmTopic),
  );

  // Prod Deploy Project alarm
  const prodDeployAlarm = new cloudwatch.Alarm(
    scope,
    "ProdDeployProjectFailedAlarm",
    {
      alarmName: "WorkoutTracer-ProdDeployProject-FailedBuilds",
      metric: new cloudwatch.Metric({
        namespace: "AWS/CodeBuild",
        metricName: "FailedBuilds",
        dimensionsMap: {
          ProjectName: prodDeployProject.projectName,
        },
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );
  prodDeployAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

  // CloudWatch Alarm for build stage (pipeline-level, not CodeBuild project)
  const buildStageAlarm = new cloudwatch.Alarm(scope, "BuildStageFailedAlarm", {
    alarmName: "WorkoutTracer-Build-Stage-Failed",
    metric: new cloudwatch.Metric({
      namespace: "AWS/CodePipeline",
      metricName: "FailedActions",
      dimensionsMap: {
        PipelineName: pipeline.pipelineName,
        StageName: "WorkoutTracer-Build",
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    }),
    threshold: 0,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  buildStageAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));
}

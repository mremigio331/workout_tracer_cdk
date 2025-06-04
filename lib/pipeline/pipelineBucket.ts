import { Stack, aws_s3 as s3, RemovalPolicy } from "aws-cdk-lib";

export function createDeploymentBucket(scope: Stack) {
  return new s3.Bucket(scope, "WorkoutTracerPipelineBucket", {
    bucketName: "workouttracer-pipeline-artifacts-" + scope.account,
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
  });
}

import {
  Stack,
  StackProps,
  RemovalPolicy,
  aws_logs as logs,
  aws_iam as iam,
  aws_kinesisfirehose as firehose,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53_targets from "aws-cdk-lib/aws-route53-targets";
import * as certmgr from "aws-cdk-lib/aws-certificatemanager";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as path from "path";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";

interface WebsiteStackProps extends StackProps {
  assetPath?: string;
  certificateArn: string;
  domainName: string;
  environmentType?: string;
  hostedZoneId: string;
  stage: string;
}

export class WebsiteStack extends Stack {
  public readonly siteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebsiteStackProps) {
    super(scope, id, props);

    const {
      domainName,
      hostedZoneId,
      certificateArn,
      assetPath,
      environmentType,
      stage,
    } = props;

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "WorkoutTracer-HostedZone",
      {
        hostedZoneId,
        zoneName: domainName,
      },
    );

    const certificate = certmgr.Certificate.fromCertificateArn(
      this,
      "WorkoutTracer-Certificate",
      certificateArn,
    );

    const loggingBucket = new s3.Bucket(
      this,
      `WorkoutTracer-AccessLogsBucket-${stage}`,
      {
        removalPolicy: RemovalPolicy.RETAIN,
        encryption: s3.BucketEncryption.S3_MANAGED,
        accessControl: s3.BucketAccessControl.LOG_DELIVERY_WRITE,
      },
    );

    const logGroup = new logs.LogGroup(
      this,
      "WorkoutTracer-CloudFrontLogGroup",
      {
        logGroupName: "/aws/cloudfront/WorkoutTracer-CloudFrontAccessLogs",
        retention: logs.RetentionDays.INFINITE,
        removalPolicy: RemovalPolicy.DESTROY,
      },
    );

    const firehoseRole = new iam.Role(this, "WorkoutTracer-FirehoseRole", {
      roleName: "WorkoutTracer-FirehoseRole",
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchLogsFullAccess"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess"),
      ],
    });

    new firehose.CfnDeliveryStream(
      this,
      "WorkoutTracer-FirehoseDeliveryStream",
      {
        deliveryStreamType: "DirectPut",
        s3DestinationConfiguration: {
          bucketArn: loggingBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          prefix: "firehose-logs/",
          bufferingHints: {
            intervalInSeconds: 300,
            sizeInMBs: 5,
          },
          cloudWatchLoggingOptions: {
            enabled: true,
            logGroupName: logGroup.logGroupName,
            logStreamName: "firehose-delivery-stream",
          },
        },
      },
    );

    const validBucketName = domainName
      .replace(/[^a-zA-Z0-9.-]/g, "")
      .replace(/^\.+/, "")
      .replace(/\.+$/, "");

    this.siteBucket = new s3.Bucket(this, `WorkoutTracer-WebsiteBucket-${stage}`, {
      bucketName: `workouttracer-website-bucket-${stage.toLowerCase()}`,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: loggingBucket,
      serverAccessLogsPrefix: "s3-access/",
    });

    const oai = new cloudfront.OriginAccessIdentity(this, "WorkoutTracerOAI");
    this.siteBucket.grantRead(oai);

    this.distribution = new cloudfront.Distribution(
      this,
      "WorkoutTracer-Distribution",
      {
        defaultRootObject: "index.html",
        domainNames: [domainName],
        certificate,
        enableLogging: true,
        logBucket: loggingBucket,
        logFilePrefix: "cloudfront-access/",
        defaultBehavior: {
          origin: new origins.S3Origin(this.siteBucket, {
            originAccessIdentity: oai,
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
    );

    new route53.ARecord(this, "WorkoutTracer-AliasRecord", {
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(
        new route53_targets.CloudFrontTarget(this.distribution),
      ),
      zone: hostedZone,
    });

    const deploymentSource =
      environmentType === "pipeline"
        ? undefined
        : s3deploy.Source.asset(
            assetPath ||
              path.join(__dirname, "../../../workout_tracer_website/dist"),
          );

    if (deploymentSource) {
      new s3deploy.BucketDeployment(this, "WorkoutTracer-WebsiteDeployment", {
        sources: [deploymentSource],
        destinationBucket: this.siteBucket,
        distribution: this.distribution,
        distributionPaths: ["/*"],
      });
    }
  }
}

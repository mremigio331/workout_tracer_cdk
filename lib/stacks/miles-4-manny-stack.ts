import {
  Stack,
  StackProps,
  RemovalPolicy,
  aws_logs as logs,
  aws_iam as iam,
  aws_kinesisfirehose as firehose,
  Duration,
  aws_certificatemanager as certmgr,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53_targets from "aws-cdk-lib/aws-route53-targets";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as path from "path";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";

interface Miles4MannyStackProps extends StackProps {
  miles4MannyDomain: string;
  miles4MannyHostedZoneId: string;
  stage: string;
}

export class Miles4MannyStack extends Stack {
  public readonly siteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: Miles4MannyStackProps) {
    super(scope, id, props);

    const { miles4MannyDomain, miles4MannyHostedZoneId, stage } = props;

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      `Miles4Manny-HostedZone-${stage}`,
      {
        hostedZoneId: miles4MannyHostedZoneId,
        zoneName: miles4MannyDomain,
      },
    );

    // Certificate in us-east-1 for CloudFront
    const certificate = new certmgr.DnsValidatedCertificate(
      this,
      `Miles4Manny-Certificate-${stage}`,
      {
        domainName: miles4MannyDomain,
        hostedZone,
        region: "us-east-1",
        subjectAlternativeNames: [miles4MannyDomain],
      },
    );

    const loggingBucket = new s3.Bucket(
      this,
      `Miles4Manny-AccessLogsBucket-${stage}`,
      {
        removalPolicy: RemovalPolicy.RETAIN,
        encryption: s3.BucketEncryption.S3_MANAGED,
        accessControl: s3.BucketAccessControl.LOG_DELIVERY_WRITE,
      },
    );

    const logGroup = new logs.LogGroup(
      this,
      `Miles4Manny-CloudFrontLogGroup-${stage}`,
      {
        logGroupName: `/aws/cloudfront/Miles4Manny-CloudFrontAccessLogs-${stage}`,
        retention: logs.RetentionDays.INFINITE,
        removalPolicy: RemovalPolicy.DESTROY,
      },
    );

    const firehoseRole = new iam.Role(
      this,
      `Miles4Manny-FirehoseRole-${stage}`,
      {
        roleName: `Miles4Manny-FirehoseRole-${stage}`,
        assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            "CloudWatchLogsFullAccess",
          ),
          iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess"),
        ],
      },
    );

    new firehose.CfnDeliveryStream(
      this,
      `Miles4Manny-FirehoseDeliveryStream-${stage}`,
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
            logStreamName: `Miles4Manny-firehose-delivery-stream-${stage}`,
          },
        },
      },
    );

    this.siteBucket = new s3.Bucket(
      this,
      `Miles4Manny-WebsiteBucket-${stage}`,
      {
        bucketName: `miles4manny-website-bucket-${stage.toLowerCase()}`,
        publicReadAccess: false,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        serverAccessLogsBucket: loggingBucket,
        serverAccessLogsPrefix: "s3-access/",
      },
    );

    const oai = new cloudfront.OriginAccessIdentity(
      this,
      `Miles4Manny-OAI-${stage}`,
    );
    this.siteBucket.grantRead(oai);

    this.distribution = new cloudfront.Distribution(
      this,
      `Miles4Manny-Distribution-${stage}`,
      {
        defaultRootObject: "index.html",
        domainNames: [miles4MannyDomain],
        certificate: certificate,
        enableLogging: true,
        logBucket: loggingBucket,
        logFilePrefix: "cloudfront-access/",
        defaultBehavior: {
          origin: new origins.S3Origin(this.siteBucket, {
            originAccessIdentity: oai,
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          responseHeadersPolicy: undefined,
        },
        errorResponses: [
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: Duration.minutes(5),
          },
        ],
      },
    );

    new route53.ARecord(this, `Miles4Manny-AliasRecord-${stage}`, {
      recordName: miles4MannyDomain,
      target: route53.RecordTarget.fromAlias(
        new route53_targets.CloudFrontTarget(this.distribution),
      ),
      zone: hostedZone,
    });

    const deploymentSource = s3deploy.Source.asset(
      path.join(__dirname, "../../../miles4manny/dist"),
    );

    const bucketDeploymentLogGroup = new logs.LogGroup(
      this,
      `Miles4Manny-BucketDeploymentLogGroup-${stage}`,
      {
        logGroupName: `/aws/lambda/Miles4Manny-WebsiteStack-BucketDeployment-${stage}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      },
    );

    if (deploymentSource) {
      new s3deploy.BucketDeployment(
        this,
        `Miles4Manny-WebsiteDeployment-${stage}`,
        {
          sources: [deploymentSource],
          destinationBucket: this.siteBucket,
          distribution: this.distribution,
          distributionPaths: ["/*"],
        },
      );
    }
  }
}

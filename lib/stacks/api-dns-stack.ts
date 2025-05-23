import {
  Stack,
  StackProps,
  aws_route53 as route53,
  aws_certificatemanager as acm,
  aws_route53_targets as targets,
  aws_apigateway as apigw,
} from "aws-cdk-lib";
import { Construct } from "constructs";

interface ApiDnsStackProps extends StackProps {
  stage: string;
  rootDomainName: string;
  apiDomainName: string;
  hostedZoneId: string;
  api: apigw.RestApi;
  certificateArn: string;
}

export class ApiDnsStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiDnsStackProps) {
    super(scope, id, props);

    const {
      stage,
      rootDomainName,
      apiDomainName,
      hostedZoneId,
      api,
      certificateArn,
    } = props;

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      `WorkoutTracer-ApiHostedZone-${stage}`,
      {
        hostedZoneId,
        zoneName: rootDomainName,
      },
    );

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      `WorkoutTracer-ImportedApiCert-${stage}`,
      certificateArn,
    );

    const customDomain = new apigw.DomainName(
      this,
      `WorkoutTracer-ApiCustomDomain-${stage}`,
      {
        domainName: apiDomainName,
        certificate: certificate!,
        endpointType: apigw.EndpointType.REGIONAL,
      },
    );

    new apigw.BasePathMapping(
      this,
      `WorkoutTracer-ApiBasePathMapping-${stage}`,
      {
        domainName: customDomain,
        restApi: api,
      },
    );

    new route53.ARecord(this, `WorkoutTracer-ApiAliasRecord-${stage}`, {
      recordName: "api",
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayDomain(customDomain),
      ),
    });
  }
}

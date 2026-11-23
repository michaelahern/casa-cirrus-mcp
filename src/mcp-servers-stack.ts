import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as vpclattice from 'aws-cdk-lib/aws-vpclattice';
import { Construct } from 'constructs';

export class ModelContextProtocolServersStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // --------------------------------
        // VPC & VPC Lattice
        // --------------------------------

        const vpc = new ec2.Vpc(this, 'VPC', {
            ipProtocol: ec2.IpProtocol.DUAL_STACK,
            maxAzs: 3,
            natGateways: 2,
            subnetConfiguration: [{
                cidrMask: 24,
                name: 'Public',
                subnetType: ec2.SubnetType.PUBLIC
            }, {
                cidrMask: 24,
                name: 'Private',
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
            }]
        });

        const sgAllowAllOutbound = new ec2.SecurityGroup(this, 'SecurityGroup:AllowAllOutbound', {
            vpc,
            allowAllOutbound: true,
            allowAllIpv6Outbound: true
        });

        const sgAllowVpcLatticeInbound = new ec2.SecurityGroup(this, 'SecurityGroup:AllowVpcLatticeInbound', {
            vpc,
            allowAllOutbound: false
        });
        sgAllowVpcLatticeInbound.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.allTcp()
        );
        new ec2.CfnSecurityGroupIngress(this, 'SecurityGroup:AllowVpcLatticeInbound:VpcIpv6', {
            groupId: sgAllowVpcLatticeInbound.securityGroupId,
            ipProtocol: 'tcp',
            fromPort: 0,
            toPort: 65535,
            cidrIpv6: cdk.Fn.select(0, vpc.vpcIpv6CidrBlocks)
        });
        sgAllowVpcLatticeInbound.addIngressRule(
            ec2.Peer.prefixList('pl-0a29265a06ed0e2f4'),
            ec2.Port.allTcp(),
            'com.amazonaws.us-east-2.vpc-lattice'
        );
        sgAllowVpcLatticeInbound.addIngressRule(
            ec2.Peer.prefixList('pl-035da5473f4b423a4'),
            ec2.Port.allTcp(),
            'com.amazonaws.us-east-2.ipv6.vpc-lattice'
        );

        const serviceNetwork = new vpclattice.CfnServiceNetwork(this, 'ServiceNetwork', {
            name: 'casa-cirrus-mcp',
            authType: 'NONE'
        });

        new vpclattice.CfnServiceNetworkVpcAssociation(this, 'ServiceNetworkVpcAssociation', {
            serviceNetworkIdentifier: serviceNetwork.attrId,
            vpcIdentifier: vpc.vpcId,
            securityGroupIds: [sgAllowVpcLatticeInbound.securityGroupId]
        });

        const dnsPrivateZone = new route53.PrivateHostedZone(this, 'DnsPrivateZone', {
            vpc,
            zoneName: 'mcp.us-east-2.aws.cirrus.casa'
        });

        // ECS Cluster
        const mcpCluster = new ecs.Cluster(this, 'Cluster', {
            vpc: vpc,
            containerInsightsV2: ecs.ContainerInsights.ENHANCED
        });

        // ECS Common
        const ecsInfraRoleForVpcLattice = new iam.Role(this, 'EcsInfraRoleForVpcLattice', {
            assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonECSInfrastructureRolePolicyForVpcLattice')
            ]
        });

        // --------------------------------
        // Cloudflare Tunnel
        // --------------------------------

        const cloudflareTaskDefinition = new ecs.FargateTaskDefinition(this, 'CloudflareTunnel:TaskDef', {
            cpu: 512,
            memoryLimitMiB: 1024,
            runtimePlatform: {
                cpuArchitecture: ecs.CpuArchitecture.ARM64,
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
            }
        });

        cloudflareTaskDefinition.addContainer('CloudflareTunnel', {
            image: ecs.ContainerImage.fromRegistry('cloudflare/cloudflared:latest'),
            command: ['tunnel', '--no-autoupdate', 'run'],
            environment: {
                TUNNEL_METRICS: '0.0.0.0:20241'
            },
            secrets: {
                TUNNEL_TOKEN: ecs.Secret.fromSecretsManager(secretsmanager.Secret.fromSecretNameV2(this, 'CloudflareTunnel:Token', 'casa-cirrus-mcp/cloudflare/tunnel-token'))
            },
            essential: true,
            healthCheck: {
                command: ['CMD', 'cloudflared', 'tunnel', 'ready'],
                interval: cdk.Duration.seconds(10),
                startPeriod: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5)
            },
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'ecs',
                logRetention: cdk.aws_logs.RetentionDays.ONE_MONTH,
                mode: ecs.AwsLogDriverMode.NON_BLOCKING
            }),
            systemControls: [{
                namespace: 'net.ipv4.ping_group_range',
                value: '0 65534'
            }]
        });

        new ecs.FargateService(this, 'CloudflareTunnel:FargateService', {
            cluster: mcpCluster,
            desiredCount: 2,
            securityGroups: [sgAllowAllOutbound],
            maxHealthyPercent: 200,
            minHealthyPercent: 50,
            healthCheckGracePeriod: cdk.Duration.minutes(1),
            circuitBreaker: {
                enable: true
            },
            taskDefinition: cloudflareTaskDefinition
        });

        // --------------------------------
        // UniFi Site Manager MCP
        // --------------------------------

        const unifiSiteManagerTaskDefinition = new ecs.FargateTaskDefinition(this, 'UnifiSiteManager:TaskDef', {
            cpu: 512,
            memoryLimitMiB: 1024,
            runtimePlatform: {
                cpuArchitecture: ecs.CpuArchitecture.ARM64,
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
            }
        });

        unifiSiteManagerTaskDefinition.addContainer('UnifiSiteManager', {
            image: ecs.ContainerImage.fromRegistry('ghcr.io/sirkirby/unifi-sitemanager-mcp:latest'),
            environment: {
                UNIFI_MCP_HTTP_ENABLED: 'true',
                UNIFI_MCP_HTTP_TRANSPORT: 'streamable-http',
                UNIFI_MCP_HOST: '0.0.0.0',
                UNIFI_MCP_PORT: '3003',
                UNIFI_MCP_ENABLE_DNS_REBINDING_PROTECTION: 'false'
            },
            secrets: {
                UNIFI_SITEMANAGER_API_KEY: ecs.Secret.fromSecretsManager(secretsmanager.Secret.fromSecretNameV2(this, 'UnifiSiteManager:ApiKey', 'casa-cirrus-mcp/unifi/sitemanager-api-key'))
            },
            essential: true,
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'ecs',
                logRetention: cdk.aws_logs.RetentionDays.ONE_MONTH,
                mode: ecs.AwsLogDriverMode.NON_BLOCKING
            }),
            portMappings: [{
                containerPort: 3003,
                protocol: ecs.Protocol.TCP,
                name: 'mcp',
                appProtocol: ecs.AppProtocol.http
            }]
        });

        const unifiSiteManagerTargetGroup = new vpclattice.CfnTargetGroup(this, 'UnifiSiteManager:LatticeTargetGroup', {
            type: 'IP',
            name: 'casa-cirrus-mcp-unifi-sitemanager',
            config: {
                port: 3003,
                protocol: 'HTTP',
                protocolVersion: 'HTTP1',
                ipAddressType: 'IPV4',
                vpcIdentifier: vpc.vpcId,
                healthCheck: {
                    enabled: true,
                    path: '/mcp',
                    protocol: 'HTTP',
                    protocolVersion: 'HTTP1',
                    matcher: {
                        httpCode: '200,400'
                    }
                }
            }
        });

        const unifiSiteManagerFargateService = new ecs.FargateService(this, 'UnifiSiteManager:FargateService', {
            cluster: mcpCluster,
            desiredCount: 1,
            securityGroups: [sgAllowAllOutbound, sgAllowVpcLatticeInbound],
            maxHealthyPercent: 100,
            minHealthyPercent: 0,
            circuitBreaker: {
                enable: true
            },
            taskDefinition: unifiSiteManagerTaskDefinition
        });

        (unifiSiteManagerFargateService.node.defaultChild as ecs.CfnService).vpcLatticeConfigurations = [
            {
                portName: 'mcp',
                roleArn: ecsInfraRoleForVpcLattice.roleArn,
                targetGroupArn: unifiSiteManagerTargetGroup.attrArn
            }
        ];

        const unifiSiteManagerLatticeService = new vpclattice.CfnService(this, 'UnifiSiteManager:LatticeService', {
            name: 'casa-cirrus-mcp-unifi-sitemanager',
            authType: 'NONE',
            customDomainName: 'unifi-sitemanager.mcp.us-east-2.aws.cirrus.casa'
        });

        new vpclattice.CfnListener(this, 'UnifiSiteManager:LatticeListener', {
            serviceIdentifier: unifiSiteManagerLatticeService.attrId,
            protocol: 'HTTP',
            port: 80,
            defaultAction: {
                forward: { targetGroups: [{ targetGroupIdentifier: unifiSiteManagerTargetGroup.attrId, weight: 100 }] }
            }
        });

        new vpclattice.CfnServiceNetworkServiceAssociation(this, 'UnifiSiteManager:LatticeServiceNetworkServiceAssociation', {
            serviceNetworkIdentifier: serviceNetwork.attrId,
            serviceIdentifier: unifiSiteManagerLatticeService.attrId
        });

        new route53.CnameRecord(this, 'UnifiSiteManager:DnsRecord', {
            zone: dnsPrivateZone,
            recordName: 'unifi-sitemanager',
            domainName: unifiSiteManagerLatticeService.attrDnsEntryDomainName
        });
    }
}

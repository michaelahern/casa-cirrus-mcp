import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class ModelContextProtocolServersStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

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

        const mcpCluster = new ecs.Cluster(this, 'Cluster', {
            vpc: vpc,
            containerInsightsV2: ecs.ContainerInsights.ENHANCED
        });

        const cloudflareTaskDefinition = new ecs.FargateTaskDefinition(this, 'CloudflareTunnelTaskDef', {
            cpu: 512,
            memoryLimitMiB: 1024,
            runtimePlatform: {
                cpuArchitecture: ecs.CpuArchitecture.ARM64,
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
            }
        });

        cloudflareTaskDefinition.addContainer('CloudflareTunnel', {
            image: ecs.ContainerImage.fromRegistry('cloudflare/cloudflared:latest'),
            command: ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:20241', 'run'],
            secrets: {
                TUNNEL_TOKEN: ecs.Secret.fromSecretsManager(secretsmanager.Secret.fromSecretNameV2(this, 'CloudflareTunnelToken', 'casa-cirrus-mcp/cloudflare/tunnel-token'))
            },
            essential: true,
            healthCheck: {
                command: ['CMD', 'cloudflared', 'tunnel', '--metrics', '127.0.0.1:20241', 'ready'],
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

        const cloudflareSecurityGroup = new ec2.SecurityGroup(this, 'CloudflareTunnelSecurityGroup', {
            vpc,
            allowAllOutbound: true,
            allowAllIpv6Outbound: true
        });

        new ecs.FargateService(this, 'CloudflareTunnelService', {
            cluster: mcpCluster,
            desiredCount: 2,
            securityGroups: [cloudflareSecurityGroup],
            maxHealthyPercent: 200,
            minHealthyPercent: 50,
            circuitBreaker: {
                enable: true
            },
            taskDefinition: cloudflareTaskDefinition
        });
    }
}

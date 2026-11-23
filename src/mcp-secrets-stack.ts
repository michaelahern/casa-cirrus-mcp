import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class ModelContextProtocolSecretsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        new secretsmanager.Secret(this, 'CloudflareTunnelToken', {
            secretName: 'casa-cirrus-mcp/cloudflare/tunnel-token'
        });

        new secretsmanager.Secret(this, 'UnifiNetworkHost', {
            secretName: 'casa-cirrus-mcp/unifi/network-host'
        });

        new secretsmanager.Secret(this, 'UnifiNetworkUsername', {
            secretName: 'casa-cirrus-mcp/unifi/network-username'
        });

        new secretsmanager.Secret(this, 'UnifiNetworkPassword', {
            secretName: 'casa-cirrus-mcp/unifi/network-password'
        });

        new secretsmanager.Secret(this, 'UnifiSiteManagerApiKey', {
            secretName: 'casa-cirrus-mcp/unifi/sitemanager-api-key'
        });
    }
}

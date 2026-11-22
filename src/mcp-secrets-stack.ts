import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class ModelContextProtocolSecretsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        new secretsmanager.Secret(this, 'CloudflareTunnelToken', {
            secretName: 'casa-cirrus-mcp/cloudflare/tunnel-token'
        });
    }
}

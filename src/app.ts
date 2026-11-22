import * as cdk from 'aws-cdk-lib';
import { ModelContextProtocolServersStack } from './mcp-servers-stack.js';
import { ModelContextProtocolSecretsStack } from './mcp-secrets-stack.js';

const app = new cdk.App();

new ModelContextProtocolSecretsStack(app, 'ModelContextProtocolSecrets', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});

new ModelContextProtocolServersStack(app, 'ModelContextProtocolServers', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});

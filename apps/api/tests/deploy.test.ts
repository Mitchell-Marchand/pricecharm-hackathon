import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../deploy/${path}`, import.meta.url), 'utf8');
const template = JSON.parse(read('infra/cloudformation.json'));
const resources = template.Resources;

test('the stack boots the host with the checked-in bootstrap script', () => {
  assert.equal(
    resources.AppInstance.Properties.UserData['Fn::Base64'],
    read('bootstrap-ec2.sh'),
    'Copy bootstrap-ec2.sh into AppInstance UserData after changing it.',
  );
});

test('only the production environment of this repository can deploy, and only by opening SSH', () => {
  const trust = resources.DeployRole.Properties.AssumeRolePolicyDocument.Statement;
  assert.equal(trust.length, 1);
  assert.equal(trust[0].Action, 'sts:AssumeRoleWithWebIdentity');
  assert.deepEqual(trust[0].Condition.StringEquals, {
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': {
      'Fn::Sub': 'repo:${GitHubRepository}:environment:production',
    },
  });
  const allowed = resources.DeployRole.Properties.Policies.flatMap(
    (policy: { PolicyDocument: { Statement: { Action: string[] }[] } }) =>
      policy.PolicyDocument.Statement.flatMap((statement) => statement.Action),
  );
  assert.deepEqual(allowed.sort(), [
    'ec2:AuthorizeSecurityGroupIngress',
    'ec2:RevokeSecurityGroupIngress',
  ]);
  assert.equal(resources.DeploySshSecurityGroup.Properties.SecurityGroupIngress, undefined);
});

test('database dumps leave the backup bucket inside the 30 days the privacy policy promises', () => {
  const [rule] = resources.BackupBucket.Properties.LifecycleConfiguration.Rules;
  assert.equal(rule.Status, 'Enabled');
  assert.ok(rule.ExpirationInDays <= 28);
  assert.equal(resources.BackupBucket.Properties.VersioningConfiguration, undefined);
});

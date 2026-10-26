import test from 'node:test';
import assert from 'node:assert/strict';
import { EVALUATOR_VERSION, type Evaluation, type Service } from '../src/domain.js';
import { automationReadiness, evaluationInvalidation } from '../src/readiness.js';

const classifier = { provider: 'openai', model: 'fictional-model' };
const service: Service = {
  id: 'service',
  businessId: 'business',
  name: 'Driveway cleaning',
  description: 'Concrete driveway cleaning',
  unitLabel: 'square feet',
  unitPriceCents: 25,
  basePriceCents: 0,
  minimumChargeCents: 10000,
  maxAutoQuoteCents: 50000,
  requiredInputs: ['area'],
  exclusions: [],
  mode: 'review',
  version: 8,
  publishedAt: '2026-01-01T00:00:00.000Z',
  approvedVersion: null,
};
const evaluation: Evaluation = {
  id: 'evaluation',
  serviceVersion: service.version,
  engineVersion: EVALUATOR_VERSION,
  languageEvaluation: { ...classifier, passed: true, caseCount: 4 },
  passed: true,
  configurationPassed: true,
  automaticReady: true,
  checks: [],
  cases: [],
  evaluatedAt: '2026-01-01T00:00:00.000Z',
};

test('saved evaluation freshness binds policy, provider, model and evaluator while preserving failed results', () => {
  assert.equal(evaluationInvalidation(null, service.version, classifier), 'not_evaluated');
  assert.equal(
    evaluationInvalidation(evaluation, service.version + 1, classifier),
    'policy_changed',
  );
  assert.equal(
    evaluationInvalidation(
      { ...evaluation, engineVersion: 'older-engine' },
      service.version,
      classifier,
    ),
    'engine_changed',
  );
  for (const changed of [
    { provider: 'anthropic', model: classifier.model },
    { provider: classifier.provider, model: 'different-model' },
  ])
    assert.equal(evaluationInvalidation(evaluation, service.version, changed), 'model_changed');
  const failed = {
    ...evaluation,
    automaticReady: false,
    languageEvaluation: { ...evaluation.languageEvaluation!, passed: false },
  };
  const result = automationReadiness(service, { autoQuoteEnabled: false }, failed, classifier);
  assert.equal(result.evaluationCurrent, true);
  assert.equal(result.invalidation, null);
  assert.deepEqual(result.evaluation, failed);
  assert.equal(result.approvalCurrent, false);
});

test('readiness reports actual publication and approval separately without granting authority', () => {
  const review = automationReadiness(service, { autoQuoteEnabled: true }, evaluation, classifier);
  assert.equal(review.published, true);
  assert.equal(review.autoQuoteEnabled, true);
  assert.equal(review.evaluationCurrent, true);
  assert.equal(review.approvalCurrent, false);
  const automatic = { ...service, mode: 'automatic' as const, approvedVersion: service.version };
  assert.equal(
    automationReadiness(automatic, { autoQuoteEnabled: false }, evaluation, classifier)
      .approvalCurrent,
    true,
  );
  for (const changed of [
    { ...automatic, approvedVersion: service.version - 1 },
    { ...automatic, publishedAt: null },
    { ...automatic, version: service.version + 1 },
  ])
    assert.equal(
      automationReadiness(changed, { autoQuoteEnabled: true }, evaluation, classifier)
        .approvalCurrent,
      false,
    );
});

import { EVALUATOR_VERSION, type Business, type Evaluation, type Service } from './domain.js';

export type EvaluationInvalidation =
  'not_evaluated' | 'policy_changed' | 'model_changed' | 'engine_changed';

export interface AutomationReadiness {
  serviceId: string;
  serviceVersion: number;
  evaluation: Evaluation | null;
  evaluationCurrent: boolean;
  invalidation: EvaluationInvalidation | null;
  approvalCurrent: boolean;
  published: boolean;
  autoQuoteEnabled: boolean;
}

/** Freshness is separate from passing: a current failed result remains useful to review. */
export function evaluationInvalidation(
  evaluation: Evaluation | null,
  serviceVersion: number,
  classifier: { provider: string; model: string },
): EvaluationInvalidation | null {
  if (!evaluation) return 'not_evaluated';
  if (evaluation.serviceVersion !== serviceVersion) return 'policy_changed';
  if (evaluation.engineVersion !== EVALUATOR_VERSION) return 'engine_changed';
  if (
    evaluation.languageEvaluation?.provider !== classifier.provider ||
    evaluation.languageEvaluation?.model !== classifier.model
  )
    return 'model_changed';
  return null;
}

export function automationReadiness(
  service: Service,
  business: Pick<Business, 'autoQuoteEnabled'>,
  evaluation: Evaluation | null,
  classifier: { provider: string; model: string },
): AutomationReadiness {
  const invalidation = evaluationInvalidation(evaluation, service.version, classifier);
  return {
    serviceId: service.id,
    serviceVersion: service.version,
    evaluation,
    evaluationCurrent: invalidation === null,
    invalidation,
    approvalCurrent: Boolean(
      service.publishedAt &&
      service.mode === 'automatic' &&
      service.approvedVersion === service.version &&
      invalidation === null &&
      evaluation?.automaticReady &&
      evaluation.languageEvaluation?.passed,
    ),
    published: Boolean(service.publishedAt),
    autoQuoteEnabled: business.autoQuoteEnabled,
  };
}

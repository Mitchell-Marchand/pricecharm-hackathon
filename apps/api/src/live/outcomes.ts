/** Why a customer didn't go ahead. They pick one when they turn a quote down. */
export const LOSS_REASONS = {
  price: 'More than I want to spend',
  someone_else: 'Went with someone else',
  timing: 'The timing doesn’t work',
  not_now: 'Not doing it for now',
  other: 'Something else',
} as const;

export type LossReason = keyof typeof LOSS_REASONS;

export const lossReasons = Object.keys(LOSS_REASONS) as [LossReason, ...LossReason[]];

export function lossReasonLabel(reason: string): string {
  return LOSS_REASONS[reason as LossReason] ?? LOSS_REASONS.other;
}

/** The reason mid-sentence: "more than I want to spend". */
export function lossReasonPhrase(reason: string): string {
  const label = lossReasonLabel(reason);
  return label.charAt(0).toLowerCase() + label.slice(1);
}

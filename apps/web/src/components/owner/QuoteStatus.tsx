import { Tag } from '@/components/ui';
import type { QuoteStatus } from '@/lib/owner';

const LABELS: Record<QuoteStatus, { text: string; tone: 'neutral' | 'accent' | 'go' | 'canary' }> =
  {
    review: { text: 'Needs your OK', tone: 'canary' },
    sent: { text: 'Sent', tone: 'accent' },
    accepted: { text: 'Accepted', tone: 'go' },
    visit_requested: { text: 'Wants a visit', tone: 'accent' },
    declined: { text: 'Declined', tone: 'neutral' },
    void: { text: 'Closed', tone: 'neutral' },
  };

export function QuoteStatusTag({ status }: { status: QuoteStatus }) {
  const label = LABELS[status] ?? LABELS.void;
  return <Tag tone={label.tone}>{label.text}</Tag>;
}

import type { Metadata } from 'next';
import { ApproveQuote } from '@/components/owner/ApproveQuote';

export const metadata: Metadata = { title: 'Approve a quote', robots: { index: false } };

export default async function ApprovePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ApproveQuote quoteId={id} />;
}

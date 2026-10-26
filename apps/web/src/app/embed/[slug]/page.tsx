import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { publicBusiness } from '@/lib/server-api';
import { EmbedChat } from './EmbedChat';

type Props = { params: Promise<{ slug: string }> };

export const metadata: Metadata = { title: 'Get a quote', robots: { index: false } };

/** The quote chat inside the business's own website, loaded by /widget.js. */
export default async function EmbedPage({ params }: Props) {
  const { slug } = await params;
  const business = await publicBusiness(slug);
  if (business === null) notFound();
  return (
    <div className="h-dvh">
      <EmbedChat slug={slug} profile={business} />
    </div>
  );
}

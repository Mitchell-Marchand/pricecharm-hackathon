import PublicWidget from '@/components/public-widget';
export default async function QuotePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <PublicWidget slug={slug} />;
}

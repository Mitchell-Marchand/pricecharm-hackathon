import PublicWidget from '@/components/public-widget';
export default async function EmbedPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <PublicWidget slug={slug} embedded />;
}

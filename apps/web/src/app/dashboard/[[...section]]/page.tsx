import DashboardApp from '@/components/dashboard';

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section } = await params;
  return <DashboardApp section={section?.join('/') || ''} />;
}

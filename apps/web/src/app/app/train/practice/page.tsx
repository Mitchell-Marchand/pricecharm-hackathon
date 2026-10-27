import { MorePractice } from '@/components/practice/MorePractice';

export default async function TrainPracticePage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string | string[] }>;
}) {
  const { run } = await searchParams;
  return <MorePractice runId={typeof run === 'string' ? run : null} />;
}

import { MorePractice } from '@/components/practice/MorePractice';

export default async function TrainPracticePage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string | string[]; service?: string | string[] }>;
}) {
  const { run, service } = await searchParams;
  return (
    <MorePractice
      runId={typeof run === 'string' ? run : null}
      service={typeof service === 'string' ? service : null}
    />
  );
}

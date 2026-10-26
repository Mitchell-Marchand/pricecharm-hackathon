import { ButtonLink, Logo } from '@/components/ui';
export default function NotFound() {
  return (
    <main className="not-found">
      <Logo />
      <span className="eyebrow">404 · A little off course</span>
      <h1>This page isn’t here.</h1>
      <p>Let’s get you back to your workspace.</p>
      <ButtonLink href="/dashboard">Go to dashboard</ButtonLink>
    </main>
  );
}

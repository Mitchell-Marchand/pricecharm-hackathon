'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Check, Mail, MessageSquareText, Receipt } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { SetupLoading } from '@/components/SetupLoading';
import { ShareSections } from '@/components/share/ShareSections';
import { useToast } from '@/components/Toast';
import { Button, ButtonLink } from '@/components/ui';
import { loadMe, loadShare, resendVerification, type Me, type Share } from '@/lib/account';
import { errorMessage } from '@/lib/api';
import { useOnboarding } from '@/lib/onboarding';

export default function LiveStep() {
  const { state } = useOnboarding();
  const notify = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const [share, setShare] = useState<Share | null>(null);

  useEffect(() => {
    loadMe()
      .then(setMe)
      .catch(() => {});
    loadShare()
      .then(setShare)
      .catch(() => {});
  }, []);

  if (!state || !share) return <SetupLoading />;
  const business = state.business.name || 'Your business';
  const firstName = me?.user.firstName || me?.user.name.split(' ')[0] || 'there';

  return (
    <div className="min-h-dvh">
      <header className="gutter mx-auto flex h-18 max-w-5xl items-center gap-3">
        <Logo href="/app" />
      </header>

      <main className="gutter mx-auto max-w-5xl pt-4 pb-20">
        {me && !me.user.emailVerified && (
          <div className="mb-8 flex flex-col gap-3 rounded-md border border-line bg-canary-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex gap-2.5 text-[15px]">
              <Mail className="mt-0.5 size-5 shrink-0" aria-hidden />
              <span>
                We sent a link to <span className="font-semibold">{me.user.email}</span>. Open it to
                confirm your email, so we can send you every quote.
              </span>
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                resendVerification()
                  .then(() => notify(`Sent. Check ${me.user.email}.`))
                  .catch((error) => notify(errorMessage(error)))
              }
            >
              Resend
            </Button>
          </div>
        )}

        <p className="inline-flex items-center gap-2 font-semibold text-go">
          <span className="inline-flex size-6 items-center justify-center rounded-full bg-go text-surface">
            <Check className="size-4" aria-hidden />
          </span>
          You&apos;re all set, {firstName}
        </p>
        <h1 className="t-hero mt-4">You&apos;re live.</h1>
        <p className="mt-5 max-w-xl text-lg text-ink-2">
          Customers can get quotes from {business} right now. Share your link, add it to your
          website, or both.
        </p>

        <div className="mt-12">
          <ShareSections business={business} share={share} onChange={setShare} />
        </div>

        <section className="mt-12 grid gap-8 md:grid-cols-3" aria-label="What happens next">
          {[
            {
              icon: Mail,
              title: 'Every quote lands in your inbox',
              text: 'You get an email each time a customer receives a quote.',
            },
            {
              icon: MessageSquareText,
              title: 'Unusual jobs wait for you',
              text: 'Anything outside your usual range comes to you first. One tap to approve.',
            },
            {
              icon: Receipt,
              title: 'Your first 10 quotes are free',
              text: 'After that you pay a small fee per quote a customer receives.',
            },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title}>
              <Icon className="size-6 text-accent" aria-hidden />
              <h3 className="t-h3 mt-3">{title}</h3>
              <p className="mt-1.5 text-ink-2">{text}</p>
            </div>
          ))}
        </section>

        <div className="mt-12 flex justify-end border-t border-line pt-8">
          <ButtonLink href="/app" size="lg">
            Go to your dashboard <ArrowRight aria-hidden />
          </ButtonLink>
        </div>
      </main>
    </div>
  );
}

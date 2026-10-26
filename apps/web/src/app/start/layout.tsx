import type { Metadata } from 'next';
import { ToastProvider } from '@/components/Toast';
import { OnboardingProvider } from '@/lib/onboarding';

export const metadata: Metadata = { title: 'Set up your AI' };

export default function StartLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <OnboardingProvider>{children}</OnboardingProvider>
    </ToastProvider>
  );
}

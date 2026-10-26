import type { Metadata } from 'next';
import LegalPage from '@/components/legal';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return <LegalPage mode="privacy" />;
}

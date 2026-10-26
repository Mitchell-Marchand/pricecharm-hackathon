import type { Metadata } from 'next';
import LegalPage from '@/components/legal';

export const metadata: Metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return <LegalPage mode="terms" />;
}

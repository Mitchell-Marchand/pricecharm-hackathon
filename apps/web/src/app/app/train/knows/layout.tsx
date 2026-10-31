import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'What your Charm knows' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

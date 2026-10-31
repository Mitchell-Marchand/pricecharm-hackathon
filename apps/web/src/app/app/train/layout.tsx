import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Train your Charm' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

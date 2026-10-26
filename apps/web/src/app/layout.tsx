import type { Metadata } from 'next';
import './design-tokens.css';
import './globals.css';
import './features.css';
import './product.css';
import './publishing.css';
import './brand.css';
import './conversation.css';

export const metadata: Metadata = {
  title: { default: 'Quotefolk — Quote the way you do', template: '%s · Quotefolk' },
  description:
    'Show your assistant a job you’ve priced. Try it as a customer, then share a quote link. Review requests and approve any prices. Automatic quotes stay off until you enable them.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

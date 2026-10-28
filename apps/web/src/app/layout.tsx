import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono, Public_Sans } from 'next/font/google';
import { Tracking } from '@/components/site/Tracking';
import { VisitCounter } from '@/components/site/VisitCounter';
import { SITE_URL } from '@/lib/site';
import './globals.css';

const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  variable: '--font-archivo',
  display: 'swap',
});
const publicSans = Public_Sans({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-public-sans',
  display: 'swap',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

const description =
  'Teach an AI how you price your jobs in about 5 minutes. It answers your customers, asks the right questions and sends quotes the way you would.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'PriceCharm: train an AI to quote like you', template: '%s · PriceCharm' },
  description,
  openGraph: {
    type: 'website',
    siteName: 'PriceCharm',
    locale: 'en_US',
    title: 'PriceCharm: train an AI to quote like you',
    description,
  },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // Smooth scrolling for in-page links; Next.js turns it off while changing pages.
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${archivo.variable} ${publicSans.variable} ${plexMono.variable}`}
    >
      <body>
        {children}
        <VisitCounter />
        <Tracking />
      </body>
    </html>
  );
}

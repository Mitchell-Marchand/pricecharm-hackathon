import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono, Public_Sans } from 'next/font/google';
import { CodeFromLink } from '@/components/site/CodeFromLink';
import { MetaPixel } from '@/components/site/MetaPixel';
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
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-mono',
  display: 'swap',
});

const description =
  'New customers get your quote in about two minutes, on your website or through a link, while you’re out working. Show it a few jobs you’ve done and it quotes with your prices and asks your questions.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'PriceCharm: quotes your customers while you work',
    template: '%s · PriceCharm',
  },
  description,
  openGraph: {
    type: 'website',
    siteName: 'PriceCharm',
    locale: 'en_US',
    title: 'PriceCharm: quotes your customers while you work',
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
        <CodeFromLink />
        <Tracking />
        <MetaPixel />
      </body>
    </html>
  );
}

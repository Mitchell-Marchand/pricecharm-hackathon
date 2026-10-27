import path from 'node:path';
import type { NextConfig } from 'next';

// Where the API listens. Set when building, like the rewrite below that uses it.
const apiBase = process.env.API_BASE_URL || process.env.API_ORIGIN || 'http://127.0.0.1:4100';

const config: NextConfig = {
  output: 'standalone',
  // The server reads business profiles for the quote link pages, so it needs the address too.
  env: { PRICECHARM_API_BASE: apiBase },
  // Dependencies are installed once at the monorepo root, so trace from there.
  outputFileTracingRoot: path.join(__dirname, '../..'),
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        // Everything but the widget's frame, whose framing rules come from src/proxy.ts.
        source: '/:path((?!embed/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
        ],
      },
      ...['/q/:slug', '/start/:path*', '/app/:path*', '/reset-password', '/verify-email'].map(
        (source) => ({
          source,
          // These URLs can carry a chat link or a one-time token, so never pass them on.
          headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
        }),
      ),
    ];
  },
  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: `${apiBase}/api/v1/:path*`,
      },
    ];
  },
};

export default config;

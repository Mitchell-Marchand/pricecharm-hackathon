import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
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
      ...[
        '/',
        '/login',
        '/signup',
        '/forgot-password',
        '/reset-password',
        '/verify-email',
        '/onboarding',
        '/dashboard/:path*',
        '/q/:slug',
      ].map((source) => ({
        source,
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
        ],
      })),
      {
        source: '/embed/:slug',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors *; object-src 'none'; base-uri 'self'",
          },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: `${process.env.API_BASE_URL || process.env.API_ORIGIN || 'http://127.0.0.1:4100'}/api/v1/:path*`,
      },
    ];
  },
};

export default config;

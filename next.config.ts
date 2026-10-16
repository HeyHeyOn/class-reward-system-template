import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The shared header (src/lib/brand.ts) is drawn in the browser too, so these are fixed when the app is built:
  // set HUB_READY=1 (and DDANSSAEM_HUB_URL) and redeploy to show the 딴쌤 hub links.
  env: {
    HUB_READY: process.env.HUB_READY ?? '',
    HUB_HOME_URL: process.env.DDANSSAEM_HUB_URL ?? '',
  },
  // The 딴쌤 hub's terms and privacy policy apply to the class since 2026-10-16; the class's own earlier
  // editions are kept on the hub under 이전 판.
  async redirects() {
    const hub = (process.env.DDANSSAEM_HUB_URL || 'https://ddanssaem.com').replace(/\/+$/, '');
    return [
      { source: '/terms', destination: `${hub}/terms`, permanent: true },
      { source: '/privacy', destination: `${hub}/privacy`, permanent: true },
    ];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
        // Restrict framing and plugins without blocking Next.js hydration, Google
        // sign-in, teacher-supplied images or the same-origin QR camera.
        { key: 'Content-Security-Policy', value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
      ],
    }];
  },
};

export default nextConfig;

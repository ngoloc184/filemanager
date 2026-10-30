import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // Navigation-only CSP: no framing, no <base>/<object>, forms post same-origin
  // (/auth/verify). script-src/connect-src wait for a nonce-based policy.
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // workspace package shipped as TypeScript source (packages/agent-core)
  transpilePackages: ["@ai-pro/agent-core"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Share URLs carry a secret token; never leak it through the Referer.
      {
        source: "/share/:token*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;

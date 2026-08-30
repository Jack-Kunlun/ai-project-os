import type { NextConfig } from "next";

export function buildContentSecurityPolicy(nodeEnv = process.env.NODE_ENV) {
  const developmentScriptSource = nodeEnv === "development" ? " 'unsafe-eval'" : "";
  const developmentConnectSource = nodeEnv === "development" ? " ws: wss:" : "";

  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${developmentScriptSource}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${developmentConnectSource}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
  ].join("; ");
}

export const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: buildContentSecurityPolicy() },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
] as const;

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["@napi-rs/canvas"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...SECURITY_HEADERS],
      },
    ];
  },
};

export default nextConfig;

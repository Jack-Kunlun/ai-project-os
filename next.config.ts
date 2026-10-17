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

const SECURITY_HEADERS_WITHOUT_OAUTH_ROUTE_POLICIES = SECURITY_HEADERS.filter(
  ({ key }) => key !== "Content-Security-Policy" && key !== "Referrer-Policy",
);
const OAUTH_ROUTE_POLICIES = SECURITY_HEADERS.filter(
  ({ key }) => key === "Content-Security-Policy" || key === "Referrer-Policy",
);

// PDF.js loads its worker with a native relative import at runtime. Preserve
// that package layout and include the worker in standalone file tracing.
const pdfWorkerRuntimeFiles = ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  outputFileTracingIncludes: {
    "/api/projects/*/assets": pdfWorkerRuntimeFiles,
    "/api/projects/*/assets/**": pdfWorkerRuntimeFiles,
    "/api/personal/knowledge/import": pdfWorkerRuntimeFiles,
  },
  webpack(config, { dev, isServer }) {
    if (!dev && !isServer && config.optimization?.splitChunks) {
      // This small shared dialog otherwise falls below Next's 20 KiB split
      // threshold and is repeated in many page bundles.
      const splitChunks = config.optimization.splitChunks;
      splitChunks.cacheGroups = {
        ...splitChunks.cacheGroups,
        operationPanel: {
          test: /[\\/]src[\\/]components[\\/]operation-panel\.tsx$/,
          name: "operation-panel",
          chunks: "all",
          minChunks: 2,
          enforce: true,
          reuseExistingChunk: true,
          priority: 40,
        },
        safeErrorPresentation: {
          test: /[\\/]src[\\/]lib[\\/]safe-error-presentation\.ts$/,
          name: "safe-error-presentation",
          chunks: "all",
          minChunks: 2,
          enforce: true,
          reuseExistingChunk: true,
          priority: 40,
        },
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS_WITHOUT_OAUTH_ROUTE_POLICIES,
      },
      {
        // The consent handler sets per-request CSP and referrer policies; Next does not replace existing response headers.
        source: "/:path((?!mcp/authorize$).*)",
        headers: OAUTH_ROUTE_POLICIES,
      },
    ];
  },
};

export default nextConfig;

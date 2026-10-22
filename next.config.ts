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
        appearance: {
          test: /[\\/]src[\\/](?:components[\\/](?:appearance-provider|appearance-controls|ui-error-text)\.tsx|lib[\\/]ui-core-messages\.json)$/,
          name: "appearance",
          chunks: "all",
          minChunks: 2,
          enforce: true,
          reuseExistingChunk: true,
          priority: 50,
        },
        // Public pages and shared dialogs use icons without loading the user shell.
        // Artwork is server-rendered; only the shared reference renderer hydrates.
        staticIcons: {
          test: /[\\/]src[\\/]components[\\/](?:shell-icon\.tsx|tabler-icon-data\.ts)$/,
          name: "static-icons",
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 45,
        },
        userNavigation: {
          test: /[\\/]src[\\/](?:components[\\/](?:(?:user-shell|workspace-scope|notification-bell|app-header)\.tsx|user-shell\.module\.css)|lib[\\/]user-navigation\.ts)$/,
          name: "user-navigation",
          chunks: "all",
          minChunks: 2,
          enforce: true,
          reuseExistingChunk: true,
          priority: 40,
        },
        accountMenu: {
          test: /[\\/]src[\\/]components[\\/]header-account\.tsx$/,
          name: "account-menu",
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 40,
        },
        operationPanel: {
          test: /[\\/]src[\\/]components[\\/]operation-panel\.tsx$/,
          name: "operation-panel",
          chunks: "all",
          minChunks: 2,
          enforce: true,
          reuseExistingChunk: true,
          priority: 40,
        },
        workspacePresentation: {
          test: /[\\/]src[\\/]components[\\/](?:workspace-dialog\.tsx|workspace-ui\.module\.css)$/,
          name: "workspace-presentation",
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 40,
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
        branding: {
          test: /(?:[\\/]src[\\/]components[\\/]brand-mark\.tsx|[\\/]node_modules[\\/]next[\\/](?:image\.js|dist[\\/]shared[\\/]lib[\\/]image-external\.js))$/,
          name: "branding",
          chunks: "all",
          minChunks: 2,
          enforce: true,
          reuseExistingChunk: true,
          priority: 40,
        },
        confirmDialog: {
          test: /[\\/]src[\\/]components[\\/](?:app-confirm-dialog|inquiry-operation)\.tsx$/,
          name: "confirm-dialog",
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 40,
        },
        modalStyles: {
          test: /[\\/]src[\\/]components[\\/]modal-styles\.ts$/,
          name: "modal-style-tokens",
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 40,
        },
        projectNavigation: {
          test: /[\\/]src[\\/]lib[\\/]project-navigation\.ts$/,
          name: "project-navigation",
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 40,
        },
        jobFailure: {
          test: /[\\/]src[\\/]lib[\\/]project-job-failure\.ts$/,
          name: "job-failure",
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 40,
        },
        accountActions: {
          test: /[\\/]src[\\/]app[\\/]logout-button\.tsx$/,
          name: "account-actions",
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 40,
        },
        inquirySession: {
          test: /[\\/]src[\\/]lib[\\/]inquiry-session\.ts$/,
          name: "inquiry-session",
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 40,
        },
        adminFrame: {
          test: /[\\/]src[\\/](?:components[\\/](?:admin-shell|admin-header)\.tsx|lib[\\/]admin-navigation\.ts)$/,
          name: "admin-frame",
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 40,
        },
        sharedPresentation: {
          test: /[\\/]src[\\/](?:components[\\/](?:(?:list-pagination|scope-evidence-card|token-usage|parent-page-link|project-parent-link|admin-page-header)\.tsx|auth-page\.module\.css)|app[\\/]projects[\\/]\[projectId\][\\/](?:memory-quality[\\/]project-memory-quality-client|members[\\/]project-members-client)\.tsx)$/,
          name(module: { resource?: string }) {
            return `ui-${(module.resource?.split(/[\\/]/).pop() ?? "common").replace(/\.(?:tsx|ts|module\.css)$/u, "")}`;
          },
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 40,
        },
        // Locale formatting is used by many small legacy pages below the default split threshold.
        uiDateFormat: {
          test: /[\\/]src[\\/]lib[\\/]ui-date-format\.ts$/,
          name: "ui-date-format",
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 40,
        },
        graphicCaptcha: {
          test: /[\\/]src[\\/]components[\\/]graphic-captcha-dialog\.tsx$/,
          name: "graphic-captcha",
          chunks: "all", minChunks: 2, enforce: true, reuseExistingChunk: true, priority: 40,
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

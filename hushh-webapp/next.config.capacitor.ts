import type { NextConfig } from "next";
import path from "path";

import packageJson from "./package.json";

/**
 * Next.js Configuration for Capacitor iOS/Android Static Export
 *
 * IMPORTANT: This config is used for building the mobile app.
 * For cloud deployment, use the standard next.config.ts
 *
 * Usage: npm run cap:build
 */
/**
 * Stamp a real app version into the client bundle.
 *
 * `NEXT_PUBLIC_*` is inlined at build time, and nothing was supplying
 * `NEXT_PUBLIC_CLIENT_VERSION`, so every observability event on every platform
 * reported `app_version: "unknown"`. That makes it impossible to tell whether
 * a release moved a metric, whether an old build is still in the wild, or
 * whether new instrumentation actually shipped.
 *
 * An explicitly supplied value still wins. The package version is the floor,
 * so the worst case is a real version instead of "unknown".
 */
const clientVersion =
  String(process.env.NEXT_PUBLIC_CLIENT_VERSION || "").trim() ||
  String(packageJson.version || "").trim() ||
  "unknown";
const vaultWriteProtocolVersion =
  String(process.env.NEXT_PUBLIC_VAULT_WRITE_PROTOCOL_VERSION || "").trim() ||
  "2.0.0";

const capacitorConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_CLIENT_VERSION: clientVersion,
    NEXT_PUBLIC_VAULT_WRITE_PROTOCOL_VERSION: vaultWriteProtocolVersion,
  },

  // Keep file tracing and workspace discovery scoped to this monorepo.
  outputFileTracingRoot: path.join(process.cwd(), ".."),

  // Static export for Capacitor WebView
  output: "export",

  experimental: {
    optimizePackageImports: ["@phosphor-icons/react"],
  },

  // Trailing slash is important for static export routing
  trailingSlash: true,

  images: {
    // Must be unoptimized for static export
    unoptimized: true,
    formats: ["image/webp", "image/avif"],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 60,
    dangerouslyAllowSVG: true,
    contentDispositionType: "inline",
  },

  // Performance optimizations
  compress: true,
  poweredByHeader: false,

  // Disable features not supported in static export
  // Note: async headers() not supported in static export

  // React strict mode
  reactStrictMode: false,

  // Disable source maps for smaller bundle
  productionBrowserSourceMaps: false,
};

export default capacitorConfig;

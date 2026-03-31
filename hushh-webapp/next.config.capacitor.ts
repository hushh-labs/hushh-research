import type { NextConfig } from "next";
import path from "path";

/**
 * Next.js Configuration for Capacitor iOS/Android Static Export
 *
 * IMPORTANT: This config is used for building the mobile app.
 * For cloud deployment, use the standard next.config.ts
 *
 * Usage: CAPACITOR_BUILD=true npm run build
 */
const capacitorConfig: NextConfig = {
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

import type { NextConfig } from "next";

/**
 * Next.js Configuration
 *
 * Supports two modes:
 * 1. Web/Cloud Run (Default): Standard server-side build, API routes enabled.
 * 2. Capacitor (Mobile): Static export, API routes disabled (ignored).
 *
 * Usage:
 * - Web: npm run build
 * - Mobile: npm run cap:build (sets CAPACITOR_BUILD=true)
 */

const isCapacitorBuild = process.env.CAPACITOR_BUILD === "true";
const distDir = process.env.NEXT_DIST_DIR?.trim() || ".next";

const config: NextConfig = {
  distDir,
  // Dynamic output mode
  // 'standalone' is REQUIRED for Docker/Cloud Run builds to reduce image size
  output: isCapacitorBuild ? "export" : "standalone",


  // Trailing slash is important for static export routing
  trailingSlash: isCapacitorBuild,

  // Page Extensions Strategy for Mobile Build
  // When building for mobile, we ONLY want to include UI pages (.tsx)
  // This effectively ignores app/api/ route.ts files, preventing invalid export errors.
  pageExtensions: isCapacitorBuild
    ? ["tsx"] // Mobile: Only include .tsx pages (no .ts API routes)
    : ["tsx", "ts", "jsx", "js"], // Web: Include everything

  images: {
    // Unoptimized for static export (Mobile)
    // Optimized for cloud (Web)
    unoptimized: isCapacitorBuild,
    formats: ["image/webp", "image/avif"],
    // Standard device sizes
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 60,
    dangerouslyAllowSVG: true,
    contentDispositionType: "inline",
  },

  // Performance optimizations
  compress: true,
  poweredByHeader: false,
  reactStrictMode: false,
  productionBrowserSourceMaps: false,
  webpack: (webpackConfig, { dev }) => {
    if (dev) {
      webpackConfig.watchOptions = {
        ...webpackConfig.watchOptions,
        ignored: [
          "**/.playwright-artifacts/**",
          "**/playwright-report/**",
          "**/test-results/**",
        ],
      };
    }

    return webpackConfig;
  },
};

export default config;

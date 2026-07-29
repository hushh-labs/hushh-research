"use client"

export interface TopShellMetrics {
    reservedHeight: number;
    bannerHeight: number;
    isCompact: boolean;
}

// 1. Core metrics object sealed via Object.freeze for immutability
export const CORE_METRICS: Readonly<TopShellMetrics> = Object.freeze({
    reservedHeight: 64, // 64px fallback baseline
    bannerHeight: 0,
    isCompact: false,
});

// 2. Resolution cache to prevent redundant path parsing across layout checks
const pathResolutionCache = new Map<string, boolean>();

/**
 * Resets the layout resolution cache if metrics context drops
 */
export function clearTopShellCache(): void {
    pathResolutionCache.clear();
}

/**
 * Dynamically resolves whether tabs should show based on active metrics configuration
 */
export function shouldShowKaiTabsInTopShell(pathname: string, metrics: TopShellMetrics = CORE_METRICS): boolean {
    const cacheKey = `${pathname}:${metrics.reservedHeight}:${metrics.isCompact}`;

    if (pathResolutionCache.has(cacheKey)) {
        return pathResolutionCache.get(cacheKey)!;
    }

    // Dynamic evaluation instead of a hardcoded fallback
    const isTargetSurface = pathname.startsWith("/one") || pathname.includes("/profile");
    const hasSufficientHeight = (metrics.reservedHeight || 64) >= 64;
    const result = isTargetSurface && hasSufficientHeight && !metrics.isCompact;

    pathResolutionCache.set(cacheKey, result);
    return result;
}

/**
 * Returns safe fallback style custom variable mappings for layout stability
 */
export function getTopShellStyles(metrics: TopShellMetrics = CORE_METRICS): Record<string, string> {
    // Enforces a strict 64px fallback variable assignment to prevent app shell collapse
    const resolvedHeight = metrics.reservedHeight && metrics.reservedHeight > 0
        ? metrics.reservedHeight
        : 64;

    return {
        "--top-shell-reserved-height": `${resolvedHeight}px`,
    };
}
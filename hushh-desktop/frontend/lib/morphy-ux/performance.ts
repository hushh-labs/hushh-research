/**
 * Morphy-UX Performance Utilities
 * ================================
 * GPU optimization for glass effects at high refresh rates (120/144/165 Hz)
 *
 * Strategy: Keep blur everywhere, but optimize via GPU layer promotion
 * and reduced blur radius for smooth 120 Hz+ performance.
 */

// ============================================================================
// GPU OPTIMIZATION CLASSES
// These promote elements to their own compositor layer for buttery scrolling
// ============================================================================

/**
 * Core GPU optimization classes
 * Apply to any glass element for hardware acceleration
 */
export const GPU_OPTIMIZED = "transform-gpu will-change-transform";

/**
 * CSS containment to limit repaint scope
 * Prevents glass elements from triggering full-page repaints
 */
export const CONTAIN_PAINT = "isolate";

/**
 * Combined performance classes for glass elements
 * Use on Cards, modals, headers with backdrop-blur
 */
export const GLASS_OPTIMIZED = `${GPU_OPTIMIZED} ${CONTAIN_PAINT}`;

// ============================================================================
// OPTIMIZED BLUR VALUES
// Reduced blur radius that still looks glassy but renders faster
// Blur cost is O(n²) - halving radius = 4x faster
// ============================================================================

/**
 * Optimized blur classes (lighter than default for performance)
 * - Standard: 6px (vs 12px default) - still visible glass, 4x faster
 * - Light: 4px - subtle glass, very fast
 * - None: backdrop-blur-none - fallback if needed
 */
export const BLUR_OPTIMIZED = {
  standard: "backdrop-blur-[6px]",
  light: "backdrop-blur-[4px]",
  none: "backdrop-blur-none",
} as const;

// ============================================================================
// GLASS PERFORMANCE PRESET
// Drop-in replacement for heavy glass effects
// ============================================================================

/**
 * Performant glass effect preset
 * Combines GPU optimization + lighter blur + containment
 */
export function getOptimizedGlassClasses(): string {
  return `${GLASS_OPTIMIZED} ${BLUR_OPTIMIZED.standard}`;
}

/**
 * Apply GPU optimization to existing glass element
 * Just add these classes alongside existing backdrop-blur
 */
export function getGPUClasses(): string {
  return GLASS_OPTIMIZED;
}

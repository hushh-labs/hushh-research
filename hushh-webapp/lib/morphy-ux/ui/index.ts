/**
 * Morphy-UX UI Components
 *
 * This folder contains Morphy-UX enhanced versions of UI components.
 * These components extend or replace shadcn/ui components with
 * physics-based interactions (ripple effects, hover animations, etc.)
 *
 * ARCHITECTURE RULE:
 * - Shadcn/ui components live in: components/ui (stock, updatable)
 * - Morphy-UX components live in: lib/morphy-ux/ui (enhanced, custom)
 *
 * When a shadcn component needs morphy physics:
 * 1. Create a morphy-ux version in this folder
 * 2. Import from lib/morphy-ux/ui instead of components/ui when a documented extension exists
 * 3. Keep shadcn/ui stock for easy package updates
 */

// Export all morphy-ux enhanced UI components
export * from "./sidebar-menu-button";
export * from "./icon";
export * from "./brand-mark";
export * from "./icon-chip";
export * from "./feature-rail";
export * from "./onboarding-feature-list";
export * from "./segmented-pill";
export * from "./segmented-tabs";

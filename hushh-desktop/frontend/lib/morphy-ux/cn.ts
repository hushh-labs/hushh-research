/**
 * Morphy-UX Class Name Utility
 * 
 * Self-contained utility for merging Tailwind classes.
 * This makes morphy-ux fully portable without external dependencies.
 */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names using clsx and tailwind-merge.
 * Handles conditional classes and prevents Tailwind conflicts.
 * 
 * @example
 * cn("px-4 py-2", isActive && "bg-blue-500", "text-white")
 * // Returns: "px-4 py-2 bg-blue-500 text-white" (if isActive)
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

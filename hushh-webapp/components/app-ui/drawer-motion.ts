/** Sample only on re-grab, never during a movement frame. A settlement may
 * still be between endpoints; starting from its target makes the drawer jump. */
export function renderedDrawerOffset(panel: HTMLElement): number {
  const transform = getComputedStyle(panel).transform;
  const match = transform.match(/^matrix(3d)?\(([^)]+)\)$/);
  if (match) {
    const values = match[2]!.split(",").map(Number);
    const offset = values[match[1] ? 12 : 4];
    if (offset !== undefined && Number.isFinite(offset)) return offset;
  }
  const translate = transform.match(/^translate3d\((-?[\d.]+)px,/);
  return translate ? Number(translate[1]) : 0;
}

/** Read the authored motion tier; reduced motion has no settlement delay. */
export function presentationMotionDuration(token: string, fallback: number): number {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const duration = Number.parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
  return Number.isFinite(duration) && duration >= 0 ? duration : fallback;
}

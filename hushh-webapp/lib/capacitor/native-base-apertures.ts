"use client";

import type { ChromeFrame } from "./native-chrome";

// Only acknowledged authored reservations; no protected content or persistence.
const slots = new Map<string, { revision: number; frame: ChromeFrame }>();
const masked = new Set<HTMLElement>();
export function setNativeBaseAperture(id: string, revision: number, frame: ChromeFrame) {
  if ((slots.get(id)?.revision ?? -1) > revision) return;
  slots.set(id, { revision, frame }); render();
}
export function removeNativeBaseAperture(id: string, revision: number) {
  if (slots.get(id)?.revision !== revision) return;
  slots.delete(id); render();
}
function render() {
  for (const element of masked) { element.style.removeProperty("clip-path"); }
  masked.clear();
  document.documentElement.classList.toggle("native-compositor-apertures", slots.size > 0);
  if (!slots.size) return;
  // Body-level overlay portals are deliberately outside this base paint owner.
  for (const element of document.querySelectorAll<HTMLElement>('[data-app-shell-root="true"]')) {
    const bounds = element.getBoundingClientRect();
    let path = `M0 0H${bounds.width}V${bounds.height}H0Z`;
    for (const { frame } of slots.values()) {
      const x = frame.x - bounds.x, y = frame.y - bounds.y;
      path += `M${x} ${y}h${frame.width}v${frame.height}h${-frame.width}Z`;
    }
    element.style.clipPath = `path(evenodd, "${path}")`;
    masked.add(element);
  }
}

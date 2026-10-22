import type { OneLocationCircleSummary } from "./types";

export const MAX_CUSTOM_CIRCLE_TYPES = 3;
export const MAX_CIRCLE_TYPE_LABEL_LENGTH = 32;

export function normalizeCircleTypeLabel(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function customCircleTypeGroups(circles: readonly OneLocationCircleSummary[]) {
  const groups = new Map<string, { label: string; circles: OneLocationCircleSummary[] }>();
  for (const circle of circles) {
    if (circle.role !== "owner" || circle.isSystem || circle.systemKind || circle.kind !== "other") continue;
    const label = normalizeCircleTypeLabel(circle.customTypeLabel ?? "");
    if (!label || label.length > MAX_CIRCLE_TYPE_LABEL_LENGTH || ["family", "friends", "other"].includes(label.toLocaleLowerCase())) continue;
    const key = label.toLocaleLowerCase();
    const group = groups.get(key) ?? { label, circles: [] };
    group.circles.push(circle);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

import type { Story } from "./types";

/** Exact four-story content and order from the mentor's V7.2 artifact. */
export const STORIES = [
  {
    id: "ask",
    label: "Less busywork",
    mascot: "working",
    title: ["Big plans.", "Less busywork."],
    description: "Plan your day and draft replies. Just ask One.",
  },
  {
    id: "know",
    label: "Find your answers",
    mascot: "thinking",
    title: ["Find answers.", "Not more tabs."],
    description: "Search your files, finances and saved details in one place.",
  },
  {
    id: "connect",
    label: "Stay close",
    mascot: "answering",
    title: ["Your people.", "Right here."],
    description: "Message, send voice notes and share location with people you choose.",
  },
  {
    id: "control",
    label: "Stay in control",
    mascot: "connected",
    title: ["Your information.", "Your call."],
    description: "Choose who sees what, and for how long. Stop access anytime.",
  },
] as const satisfies readonly Story[];

export const PAID_ACCESS_DESCRIPTION =
  "Choose who sees what, for how long, and your price for document access.";

export function clampStep(value: number, total = STORIES.length): number {
  return Math.max(0, Math.min(total - 1, Number.isFinite(value) ? Math.trunc(value) : 0));
}

export function assetUrl(name: string, base = "/onboarding/mentor-v72"): string {
  return `${base.replace(/\/+$/, "")}/${name}`;
}

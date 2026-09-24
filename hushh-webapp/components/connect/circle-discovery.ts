import type {
  OneLocationCircleKind,
  OneLocationCircleSummary,
} from "@/lib/one-location/types";

/** Starter names, not new permission or agent categories. */
export const CIRCLE_STARTERS = [
  {
    id: "family",
    label: "Family",
    name: "Family Circle",
    kind: "family",
    description:
      "Bring your family together in one circle, ready when you want to share with them.",
  },
  {
    id: "finance",
    label: "Finance",
    name: "Finance Circle",
    kind: "other",
    description:
      "Keep your CA, financial advisor and other finance connections together.",
  },
  {
    id: "investor",
    label: "Investor",
    name: "Investor Circle",
    kind: "other",
    description:
      "Organize your investor and RIA connections into a circle of their own.",
  },
  {
    id: "business",
    label: "Business",
    name: "Business Circle",
    kind: "other",
    description:
      "A circle for your co-founders, colleagues and business connections.",
  },
  {
    id: "location",
    label: "Location",
    name: "Location Circle",
    kind: "other",
    description:
      "Keep the people you choose for location sharing together. Start sharing from Location.",
  },
  {
    id: "sms",
    label: "SMS",
    name: "SMS Circle",
    kind: "other",
    description:
      "Choose the people who receive your Save My Soul alert when you trigger it.",
  },
] as const satisfies readonly {
  id: string;
  label: string;
  name: string;
  kind: OneLocationCircleKind;
  description: string;
}[];

export type CircleStarter = (typeof CIRCLE_STARTERS)[number];
export type CircleStarterId = CircleStarter["id"];

export type ConnectCirclesSnapshot = {
  ownerId: string | null;
  loading: boolean;
  error: string | null;
  count: number;
  available: boolean;
  circles: readonly OneLocationCircleSummary[];
};

export const EMPTY_CIRCLES_SNAPSHOT: ConnectCirclesSnapshot = {
  ownerId: null,
  loading: true,
  error: null,
  count: 0,
  available: false,
  circles: [],
};

/** Reuse an owned starter by its current name. `other` alone carries no purpose.
 * Renamed/custom circles remain in the full Circles list; we never guess their purpose.
 * A user-named "SMS Circle" is not the product's emergency roster. */
export function findStarterCircle(
  circles: readonly OneLocationCircleSummary[],
  starter: CircleStarter,
): OneLocationCircleSummary | undefined {
  return circles.find((circle) => {
    if (circle.role !== "owner") return false;
    const systemKind = circle.systemKind || (circle.isSystem ? "sms" : null);
    if (starter.id === "sms") return systemKind === "sms";
    if (systemKind) return false;
    const name = circle.name.trim().toLowerCase();
    return (
      circle.kind === starter.kind &&
      (name === starter.name.toLowerCase() ||
        name === starter.label.toLowerCase())
    );
  });
}

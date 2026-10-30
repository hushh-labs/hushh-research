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
      "Keep family members in one group so you can easily choose who to share with.",
  },
  {
    id: "finance",
    label: "Finance",
    name: "Finance Circle",
    kind: "other",
    description:
      "Group the people who help with your money and taxes, like your accountant.",
  },
  {
    id: "investor",
    label: "Investor",
    name: "Investor Circle",
    kind: "other",
    description:
      "Group the people who help you plan investments, like your investment advisor.",
  },
  {
    id: "business",
    label: "Business",
    name: "Business Circle",
    kind: "other",
    description:
      "Keep the people you work with in one group, separate from family and friends.",
  },
  {
    id: "location",
    label: "Location",
    name: "Location Circle",
    kind: "other",
    description:
      "Choose a group to share your location with. Start sharing from Location when you want.",
  },
  {
    id: "sms",
    label: "SMS",
    name: "SMS Circle",
    kind: "other",
    description:
      "Choose who to alert when you need help. Send an alert from Save My Soul.",
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

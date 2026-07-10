import type { ConnectionRelationship } from "@/lib/services/connections-service";

export interface RelationshipCta {
  label: string;
  disabled: boolean;
  action: "connect" | "respond" | "none";
}

export function relationshipCta(relationship: ConnectionRelationship): RelationshipCta {
  switch (relationship) {
    case "connected":
      return { label: "Connected", disabled: true, action: "none" };
    case "pending_outgoing":
      return { label: "Requested", disabled: true, action: "none" };
    case "pending_incoming":
      return { label: "Respond", disabled: false, action: "respond" };
    default:
      return { label: "Connect", disabled: false, action: "connect" };
  }
}

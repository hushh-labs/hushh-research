/**
 * Location Tools Intent Classification & Query Formatter
 *
 * Distinguishes read-only location queries (e.g., "who has shared location with me",
 * "who can see my location") from state-changing action/navigation tools.
 * Formats query results into direct natural-language text and structured inline suggestion chips.
 */

export type InlineSuggestionChip = {
  id: string;
  label: string;
  actionUrl?: string;
  actionId?: string;
  kind: "navigation" | "action";
  params?: Record<string, unknown>;
};

export type LocationQueryResult = {
  chatAnswer: string;
  suggestionChips: InlineSuggestionChip[];
  data: Record<string, unknown>;
};

/**
 * List of read-only query tool names / directive types that should execute
 * automatically with ZERO confirmation steps.
 */
const READ_ONLY_LOCATION_TOOLS = new Set([
  "list_incoming_location_shares",
  "list_active_location_shares",
  "list_public_links",
  "list_location_recipients",
  "get_incoming_shares",
  "get_active_shares",
  "get_public_links",
  "get_location_recipients",
  "query_incoming_shares",
  "query_active_shares",
]);

/**
 * Returns true if a location tool/directive is a read-only informational query.
 */
export function isReadOnlyLocationQuery(toolNameOrType: string): boolean {
  if (!toolNameOrType) return false;
  const normalized = toolNameOrType.trim().toLowerCase();
  return READ_ONLY_LOCATION_TOOLS.has(normalized);
}

/**
 * Format relative expiry timestamp into human-readable string (e.g. "until 5:30 PM" or "expires in 2 hours").
 */
export function formatExpiryHint(expiresAt?: string | number | null): string | null {
  if (!expiresAt) return null;
  try {
    const date = new Date(expiresAt);
    if (isNaN(date.getTime())) return null;
    const now = Date.now();
    const diffMinutes = Math.round((date.getTime() - now) / (1000 * 60));
    if (diffMinutes <= 0) return "expired";
    if (diffMinutes < 60) return `until ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    const hours = Math.round(diffMinutes / 60);
    return `until ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (${hours}h remaining)`;
  } catch {
    return null;
  }
}

/**
 * Executes or formats the response for a read-only location query tool.
 */
export function formatLocationQueryResponse(
  type: string,
  payload: Record<string, unknown>,
): LocationQueryResult {
  const normalizedType = type.trim().toLowerCase();

  // 1. Incoming location shares (who has shared location with me)
  if (
    normalizedType === "list_incoming_location_shares" ||
    normalizedType === "get_incoming_shares" ||
    normalizedType === "query_incoming_shares"
  ) {
    const rawShares = (payload.incomingShares ?? payload.shares ?? []) as Record<string, unknown>[];
    if (!Array.isArray(rawShares) || rawShares.length === 0) {
      return {
        chatAnswer: "No one is currently sharing their live location with you.",
        suggestionChips: [
          {
            id: "req-location",
            label: "📍 Request Location",
            kind: "action",
            actionId: "location.request_access",
          },
        ],
        data: { incomingShares: [] },
      };
    }

    const sharerLabels = rawShares.map((share) => {
      const name = String(share.ownerDisplayName || share.displayName || share.name || "Someone");
      const expiry = formatExpiryHint(share.expiresAt as string);
      return expiry ? `${name} (${expiry})` : name;
    });

    const formattedList =
      sharerLabels.length === 1
        ? `${sharerLabels[0]}`
        : sharerLabels.length === 2
          ? `${sharerLabels[0]} and ${sharerLabels[1]}`
          : `${sharerLabels.slice(0, -1).join(", ")}, and ${sharerLabels[sharerLabels.length - 1]}`;

    return {
      chatAnswer: `${formattedList} ${sharerLabels.length === 1 ? "is" : "are"} currently sharing live location with you.`,
      suggestionChips: [
        {
          id: "view-map",
          label: "🗺️ View on Map",
          actionUrl: "/one/location",
          kind: "navigation",
        },
        {
          id: "open-shared",
          label: "📍 Open Shared with Me",
          actionUrl: "/one/location?tab=received",
          kind: "navigation",
        },
      ],
      data: { incomingShares: rawShares },
    };
  }

  // 2. Outgoing / active location shares (who can see my location)
  if (
    normalizedType === "list_active_location_shares" ||
    normalizedType === "get_active_shares" ||
    normalizedType === "query_active_shares"
  ) {
    const rawShares = (payload.activeShares ?? payload.shares ?? []) as Record<string, unknown>[];
    if (!Array.isArray(rawShares) || rawShares.length === 0) {
      return {
        chatAnswer: "You are not currently sharing your location with anyone.",
        suggestionChips: [
          {
            id: "share-location",
            label: "➕ Share Location",
            kind: "action",
            actionId: "location.create_share",
          },
        ],
        data: { activeShares: [] },
      };
    }

    const recipientLabels = rawShares.map((share) => {
      const name = String(share.recipientDisplayName || share.displayName || share.name || "Someone");
      const expiry = formatExpiryHint(share.expiresAt as string);
      return expiry ? `${name} (${expiry})` : name;
    });

    const formattedList =
      recipientLabels.length === 1
        ? `${recipientLabels[0]}`
        : recipientLabels.length === 2
          ? `${recipientLabels[0]} and ${recipientLabels[1]}`
          : `${recipientLabels.slice(0, -1).join(", ")}, and ${recipientLabels[recipientLabels.length - 1]}`;

    return {
      chatAnswer: `You are currently sharing your location with ${formattedList}.`,
      suggestionChips: [
        {
          id: "manage-shares",
          label: "📍 Manage Location Shares",
          actionUrl: "/one/location?tab=active",
          kind: "navigation",
        },
        {
          id: "stop-sharing",
          label: "🛑 Stop Sharing",
          kind: "action",
          actionId: "location.revoke_share",
        },
      ],
      data: { activeShares: rawShares },
    };
  }

  // 3. Public links
  if (normalizedType === "list_public_links" || normalizedType === "get_public_links") {
    const rawLinks = (payload.publicLinks ?? payload.links ?? []) as Record<string, unknown>[];
    if (!Array.isArray(rawLinks) || rawLinks.length === 0) {
      return {
        chatAnswer: "You have no active public location links.",
        suggestionChips: [
          {
            id: "create-public-link",
            label: "🔗 Create Public Link",
            kind: "action",
            actionId: "location.propose_public_link",
          },
        ],
        data: { publicLinks: [] },
      };
    }

    return {
      chatAnswer: `You have ${rawLinks.length} active public location link${rawLinks.length > 1 ? "s" : ""}.`,
      suggestionChips: [
        {
          id: "manage-links",
          label: "🔗 Manage Public Links",
          actionUrl: "/one/location?tab=links",
          kind: "navigation",
        },
      ],
      data: { publicLinks: rawLinks },
    };
  }

  // 4. Default fallback for other read-only location queries
  return {
    chatAnswer: "Location query completed.",
    suggestionChips: [
      {
        id: "view-map-default",
        label: "🗺️ View on Map",
        actionUrl: "/one/location",
        kind: "navigation",
      },
    ],
    data: payload,
  };
}

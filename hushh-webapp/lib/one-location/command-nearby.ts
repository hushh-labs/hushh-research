import type {
  LocalActionPreparation,
  LocalActionResources,
} from "@/lib/agent/local-onboarding-actions";
import type {
  OneLocationNearbyPresenceState,
  PlainLocationPoint,
} from "@/lib/one-location/types";

export const NEARBY_COMMAND_CONSENT_VERSION = "one-location-nearby-presence-v3";
type Place = { placeId: string; name: string };
type Choice = { placeId?: string; duration?: number };
export type NearbyCommandBinding = Record<string, unknown> & {
  owner: string;
  placeId: string;
  placeLabel: string;
  durationMinutes: 30 | 60 | 120;
  allowConnectionRequests: boolean;
  consentVersion: string;
};
const encode = (choice: Choice) => `nearby-choice:${JSON.stringify(choice)}`;

export type NearbyCheckoutBinding = Record<string, unknown> & {
  owner: string;
  presenceId: string | null;
  presenceVersion: number;
};

export async function prepareNearbyCheckout(input: {
  owner: string | null;
  read(): Promise<OneLocationNearbyPresenceState>;
}): Promise<LocalActionPreparation> {
  if (!input.owner)
    return {
      status: "blocked",
      gate: "input",
      summary: "Unlock One to end your Nearby check-in.",
    };
  const state = await input.read();
  const presence = state.presence;
  if (
    presence &&
    (!presence.id ||
      !Number.isSafeInteger(presence.version) ||
      (presence.version ?? 0) < 1)
  )
    return {
      status: "blocked",
      gate: "navigation",
      route: "/one/location/check-in",
      waitForUser: true,
      summary:
        "Review this check-in on the Nearby screen. Its current version could not be verified.",
    };
  return {
    status: "ready",
    binding: {
      owner: input.owner,
      presenceId: presence?.id ?? null,
      presenceVersion: presence?.version ?? 0,
    },
    summary: presence
      ? `End your Nearby check-in${presence.placeLabel ? ` at ${presence.placeLabel}` : ""}. Your other location shares stay as they are.`
      : "You have no active Nearby check-in.",
  };
}

/** Both entrypoints use the same checkout port; commands additionally verify a receipt. */
export async function performNearbyCheckout(input: {
  binding?: NearbyCheckoutBinding;
  operationId?: string;
  signal?: AbortSignal;
  current(): boolean;
  save(): Promise<OneLocationNearbyPresenceState>;
}): Promise<OneLocationNearbyPresenceState> {
  if (!input.current() || input.signal?.aborted)
    throw Error("Checkout was interrupted before it was sent.");
  if (input.operationId && !input.binding)
    throw Error("Refresh the check-in before ending it.");
  const state = await input.save();
  if (!input.current())
    throw Error("Your account changed. Review Nearby after unlocking.");
  if (input.operationId) {
    const receipt = state.checkoutReceipt;
    if (
      !receipt ||
      receipt.operation_id !== input.operationId ||
      receipt.checked_out !== true ||
      receipt.presence_id !== input.binding!.presenceId ||
      receipt.version !== input.binding!.presenceVersion
    )
      throw Error(
        "Checkout has no correlated receipt. Review Nearby before trying again.",
      );
  } else if (state.checkedOut !== true)
    throw Error("Nearby did not confirm checkout. Review its current status.");
  return state;
}

export async function prepareNearbyCommand(input: {
  owner: string | null;
  slots: Record<string, unknown>;
  choice?: string;
  resources?: LocalActionResources;
  candidates: Place[];
  currentPresence: string | null;
  details(
    id: string,
  ): Promise<{ placeId?: string | null; label?: string | null }>;
}): Promise<LocalActionPreparation> {
  if (!input.owner)
    return {
      status: "blocked",
      gate: "input",
      summary: "Unlock One to check in nearby.",
    };
  let choice: Choice = {};
  if (input.choice?.startsWith("nearby-choice:")) {
    try {
      choice = JSON.parse(input.choice.slice("nearby-choice:".length));
    } catch {
      /* Expired choices are not identities. */
    }
    if (!choice || typeof choice !== "object") choice = {};
  }
  const source = input.resources?.place;
  let placeId =
    source?.length === 1 && source[0]?.kind === "place"
      ? source[0].id
      : choice.placeId;
  if (!placeId) {
    const name = String(input.slots.place || "")
      .trim()
      .toLocaleLowerCase();
    const matches = input.candidates.filter(
      (place) => name && place.name.trim().toLocaleLowerCase() === name,
    );
    if (matches.length === 1) placeId = matches[0]!.placeId;
    else
      return {
        status: "blocked",
        gate: "input",
        summary: "Which nearby place should I use?",
        choices: (matches.length ? matches : input.candidates)
          .slice(0, 10)
          .map((place) => ({
            id: encode({ ...choice, placeId: place.placeId }),
            label: place.name,
          })),
      };
  }
  const place = await input.details(placeId);
  if (place.placeId !== placeId || !place.label)
    return {
      status: "blocked",
      gate: "input",
      summary:
        "That place could not be refreshed. Choose another nearby result.",
    };
  const duration = choice.duration ?? Number(input.slots.duration_minutes);
  if (![30, 60, 120].includes(duration))
    return {
      status: "blocked",
      gate: "input",
      summary: "Choose 30, 60 or 120 minutes for this check-in.",
      choices: [30, 60, 120].map((value) => ({
        id: encode({ placeId, duration: value }),
        label: `${value} minutes`,
      })),
    };
  const allow = input.slots.allow_connection_requests === "on";
  return {
    status: "ready",
    binding: {
      owner: input.owner,
      placeId,
      placeLabel: place.label,
      durationMinutes: duration,
      allowConnectionRequests: allow,
      consentVersion: NEARBY_COMMAND_CONSENT_VERSION,
      currentPresence: input.currentPresence,
    },
    summary: `Check in at ${place.label} for ${duration} minutes. Show your name to people checked in nearby. ${allow ? "People here may ask to connect." : "Connection requests are off."}${input.currentPresence ? " This replaces your current check-in." : ""}`,
  };
}

/** One effect port for taps and commands. Device capture stays client-owned. */
export async function performNearbyCheckIn(input: {
  placeId: string;
  durationMinutes: 30 | 60 | 120;
  consentAccepted: boolean;
  allowConnectionRequests: boolean;
  operationId?: string;
  consentVersion?: string;
  capture(): Promise<PlainLocationPoint>;
  current(): boolean;
  signal?: AbortSignal;
  save(point: PlainLocationPoint): Promise<OneLocationNearbyPresenceState>;
}) {
  if (!input.consentAccepted || !input.current() || input.signal?.aborted)
    throw Error("Review Nearby visibility before checking in.");
  const point = await input.capture();
  if (!input.current() || input.signal?.aborted)
    throw Error("The check-in was interrupted before it was sent.");
  const result = await input.save(point);
  if (!input.current())
    throw Error(
      "Your account changed. Review the saved operation after unlocking.",
    );
  if (input.operationId) {
    if (
      result.operationReceipt?.operation_id !== input.operationId ||
      !result.operationReceipt.presence_id ||
      result.operationReceipt.version < 1
    )
      throw Error(
        "The check-in has no correlated save receipt. Review Nearby before trying again.",
      );
  } else if (!result.presence || result.presence.status !== "active") {
    throw Error(
      "Nearby did not confirm an active check-in. Review its current status.",
    );
  }
  return { point, state: result };
}

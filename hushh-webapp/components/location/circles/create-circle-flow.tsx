"use client";

/**
 * `/one/location?action=create-circle` — name a circle and pick its kind.
 *
 * Creating a circle sends no invitations and shares no location; adding people
 * is the next screen. The tap path calls `createNamedCircle`; the voice path
 * ends the same way — a `create_circle` result with status `created` (from a
 * `tool.result` or a `pending_action.resolved executed` frame) navigates to
 * the new circle's detail. `already_exists` opens the existing one instead
 * and says so.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { INPUT_CLASSNAME } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import {
  hrefForLocationAction,
  hrefForLocationView,
} from "@/lib/location/screen-ids";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { CARD_SURFACE, MUTED_TEXT } from "@/lib/morphy-ux/tokens/surfaces";
import { TaskFlowHeader } from "@/lib/morphy-ux/ui/surface-primitives";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleKind } from "@/lib/one-location/types";
import {
  NOT_SUCCESS_STATUSES,
  type ToolResultPublic,
} from "@/lib/one-voice/protocol";
import {
  useVoiceSessionSelector,
  useVoiceToolEffects,
} from "@/lib/one-voice/session-store";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { deriveLocationVoiceActions } from "@/lib/voice/location-voice-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

const SCREEN_ID = "one_location_circles";
const VOICE_ACTIONS = deriveLocationVoiceActions(SCREEN_ID);
const CIRCLE_NAME_MAX = 80;

const KIND_OPTIONS: Array<{
  value: OneLocationCircleKind;
  label: string;
  hint: string;
}> = [
  { value: "family", label: "Family", hint: "People at home" },
  { value: "friends", label: "Friends", hint: "People you go out with" },
  { value: "other", label: "Other", hint: "Anything else" },
];

/** The circle id a `create_circle` result names, or null. Never a spoken name. */
function circleIdFromResult(result: ToolResultPublic | null): string | null {
  if (!result) return null;
  const circle = result.circle;
  if (!circle || typeof circle !== "object") return null;
  const id = (circle as { circle_id?: unknown }).circle_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export type CreateCircleFlowProps = {
  /** Called after the tap path creates a circle; defaults to opening its detail. */
  onCreated?: (circleId: string) => void;
};

export function CreateCircleFlow({ onCreated }: CreateCircleFlowProps = {}) {
  const router = useRouter();
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<OneLocationCircleKind>("other");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const pendingCreate = useVoiceSessionSelector((state) =>
    state.pendingAction &&
    state.pendingAction.tool === "create_circle" &&
    state.pendingAction.resolvedStatus === null
      ? state.pendingAction
      : null,
  );

  usePublishVoiceSurfaceMetadata(
    userId
      ? {
          screenId: SCREEN_ID,
          title: "New circle",
          purpose: "Name a new circle. Adding people comes after.",
          spokenSubject: "Location, New circle",
          actions: VOICE_ACTIONS,
          availableActions: VOICE_ACTIONS.map((action) => action.label),
        }
      : null,
  );

  // The relay mirrors a confirmed action as BOTH `pending_action.resolved`
  // and `tool.result`; open the circle once per id, not once per frame.
  const openedRef = useRef<string | null>(null);
  const openCircle = useCallback(
    (circleId: string) => {
      if (openedRef.current === circleId) return;
      openedRef.current = circleId;
      if (onCreated) {
        onCreated(circleId);
        return;
      }
      router.replace(hrefForLocationAction("circle-detail", { circleId }));
    },
    [onCreated, router],
  );

  useVoiceToolEffects({
    onToolResult: (tool, result) => {
      if (tool !== "create_circle" || NOT_SUCCESS_STATUSES.has(result.status))
        return;
      const circleId = circleIdFromResult(result);
      if (!circleId) return;
      if (result.status === "created") openCircle(circleId);
      else if (result.status === "already_exists") {
        morphyToast.info("You already have a circle with that name.");
        openCircle(circleId);
      }
    },
    onPendingResolved: (_id, resolved, result) => {
      if (resolved !== "executed" || !result) return;
      const circleId = circleIdFromResult(result);
      if (!circleId) return;
      if (result.status === "created") openCircle(circleId);
      else if (result.status === "already_exists") {
        morphyToast.info("You already have a circle with that name.");
        openCircle(circleId);
      }
    },
  });

  const submit = useCallback(async () => {
    const trimmed = name.trim().slice(0, CIRCLE_NAME_MAX);
    if (!trimmed) {
      setError("Give the circle a name.");
      return;
    }
    if (!vaultOwnerToken) {
      setError("Unlock your vault to create a circle.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const circle = await OneLocationService.createNamedCircle({
        vaultOwnerToken,
        name: trimmed,
        kind,
      });
      morphyToast.success(`${circle.name} created.`);
      openCircle(circle.id);
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : "Couldn't create the circle.",
      );
      setBusy(false);
    }
  }, [kind, name, openCircle, vaultOwnerToken]);

  return (
    <section className="space-y-5" data-testid="one-location-create-circle">
      <TaskFlowHeader
        eyebrow="Location"
        title="New circle"
        description="A circle is a group you can share with together. Creating one shares nothing yet."
      />

      {pendingCreate ? (
        <div
          className={cn(CARD_SURFACE, "p-3.5")}
          role="status"
          data-testid="create-circle-voice-pending"
        >
          <p className="ui-text-row-label-emphasized">
            Confirm on the card to create it
          </p>
          <p className={MUTED_TEXT}>{pendingCreate.summary}</p>
        </div>
      ) : null}

      <form
        className={cn(CARD_SURFACE, "space-y-5 p-5")}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-2">
          <label
            className="ui-text-row-label-emphasized block"
            htmlFor="create-circle-name"
          >
            Name
          </label>
          <input
            id="create-circle-name"
            className={cn(INPUT_CLASSNAME, "min-h-11 w-full")}
            value={name}
            maxLength={CIRCLE_NAME_MAX}
            placeholder="Family, Hiking crew…"
            autoComplete="off"
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? "create-circle-error" : undefined}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError(null);
            }}
          />
          <p className={MUTED_TEXT}>
            {name.trim().length}/{CIRCLE_NAME_MAX}
          </p>
        </div>

        <fieldset className="space-y-2">
          <legend className="ui-text-row-label-emphasized">Kind</legend>
          <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-3">
            {KIND_OPTIONS.map((option) => {
              const selected = option.value === kind;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setKind(option.value)}
                  className={cn(
                    "min-h-11 rounded-[var(--app-card-radius-compact,16px)] border px-3 py-2.5 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)]",
                    selected
                      ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent-tint)]"
                      : "border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-compact)]",
                  )}
                >
                  <span className="ui-text-row-label-emphasized block">
                    {option.label}
                  </span>
                  <span className={cn(MUTED_TEXT, "block")}>{option.hint}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {error ? (
          <p
            id="create-circle-error"
            className="ui-text-row-description text-[color:var(--app-destructive)]"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? (
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : null}
            Create circle
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => router.replace(hrefForLocationView("circles"))}
          >
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}

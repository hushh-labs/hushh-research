"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  submitLocationCircleNameDirective,
  type LocationCircleNameDirectiveV1,
  type LocationCircleNameSubmitResultV1,
} from "@/lib/services/location-circle-name-interaction-client";
import { snapKaiBottomChromeVisible } from "@/lib/navigation/kai-bottom-chrome-visibility";

type LocationCircleNameInputCardProps = {
  directive: LocationCircleNameDirectiveV1 | null;
  vaultOwnerToken: string | null | undefined;
  onDismiss: () => void;
  onSettled: (result: LocationCircleNameSubmitResultV1) => void;
};

/**
 * The fixed, compiled surface for the one required free-form Circle slot.
 *
 * The directive is minted and leased by the server.  This component only
 * renders the fixed field and sends its value to that directive's dedicated
 * settlement endpoint; it never chooses an action, constructs a run, or
 * stores the name outside React's short-lived controlled input state.
 */
export function LocationCircleNameInputCard({
  directive,
  vaultOwnerToken,
  onDismiss,
  onSettled,
}: LocationCircleNameInputCardProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const expired = useMemo(
    () => Boolean(directive && Date.parse(directive.expiresAt) <= Date.now()),
    [directive],
  );

  useEffect(() => {
    // A different server lease must never inherit raw input entered for an
    // earlier request.  Clearing is also important after a route remount.
    setName("");
    setError(null);
    setSubmitting(false);
  }, [directive?.directiveId]);

  useEffect(() => {
    if (directive) snapKaiBottomChromeVisible();
  }, [directive]);

  if (!directive) return null;

  const dismiss = () => {
    setName("");
    setError(null);
    onDismiss();
  };

  const submit = async () => {
    if (submitting || expired) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitLocationCircleNameDirective(
        directive,
        name,
        vaultOwnerToken,
      );
      // Never retain a user-provided name once it has crossed the leased
      // boundary.  The result has only static identifiers/copy keys.
      setName("");
      onSettled(result);
      if (result.status === "verified") {
        onDismiss();
      } else if (result.status === "working") {
        setError("Creating your Circle. This request will update when it settles.");
      } else {
        setError("Agent One could not create that Circle. Try again.");
      }
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : "Agent One could not save the Circle name. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="agent-approval-glass pointer-events-auto w-full max-w-[min(calc(100vw-3rem),392px)] rounded-3xl p-4 text-[#1d1d1f] dark:text-[#f5f5f7]"
      data-testid="location-circle-name-card"
      aria-label="Name your Circle"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-[15px] font-semibold text-foreground">Name your Circle</p>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        Choose a name for this Circle.
      </p>
      <label className="mt-4 block text-[13px] font-medium text-foreground" htmlFor="location-circle-name">
        Circle name
      </label>
      <Input
        id="location-circle-name"
        data-testid="location-circle-name-input"
        className="mt-2"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={80}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={submitting || expired}
        aria-describedby={error ? "location-circle-name-error" : undefined}
      />
      {expired ? (
        <p id="location-circle-name-error" className="mt-2 text-xs text-destructive" role="status">
          This request expired. Ask One to create the Circle again.
        </p>
      ) : null}
      {error ? (
        <p id="location-circle-name-error" className="mt-2 text-xs text-destructive" role="status">
          {error}
        </p>
      ) : null}
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <Button type="button" variant="outline" size="default" disabled={submitting} onClick={dismiss}>
          Not now
        </Button>
        <Button
          type="submit"
          size="default"
          data-testid="location-circle-name-submit"
          disabled={expired || !name.trim()}
          isLoading={submitting}
        >
          Create Circle
        </Button>
      </div>
    </form>
  );
}

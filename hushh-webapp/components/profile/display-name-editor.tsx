"use client";

/**
 * Change the person's own Hussh display name.
 *
 * The rules mirror the server's `validate_display_name` (2-60 characters
 * after whitespace collapse, no control characters, no links or @handles) so
 * a name the server would refuse is caught before the request; the server's
 * own 422 message still wins and shows inline when it disagrees.
 *
 * The name on screen comes only from what the server sent back: the identity
 * returned by PATCH /api/account/identity/display-name, or the
 * `update_display_name` voice tool result (status `updated`, or
 * `committed_sync_pending` when the provider holds the name and the shadow is
 * still catching up). It is never the input's text and never a transcript.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { User } from "firebase/auth";
import {
  SpinnerGapIcon as Loader2,
} from "@/components/icons";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import type { AccountIdentity } from "@/lib/services/api-service";
import { cn } from "@/lib/utils";

export const DISPLAY_NAME_MIN_LENGTH = 2;
export const DISPLAY_NAME_MAX_LENGTH = 60;

/** Collapse runs of whitespace the way the server does before measuring. */
export function normalizeDisplayName(value: string): string {
  return String(value ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/**
 * Client-side mirror of the server rule. Returns the message to show, or
 * null when the name would be accepted. Messages match the server's so the
 * person reads one sentence whichever side refused.
 */
export function validateDisplayName(value: string): string | null {
  const normalized = normalizeDisplayName(value);
  if (
    normalized.length < DISPLAY_NAME_MIN_LENGTH ||
    normalized.length > DISPLAY_NAME_MAX_LENGTH
  ) {
    return `Display name must be between ${DISPLAY_NAME_MIN_LENGTH} and ${DISPLAY_NAME_MAX_LENGTH} characters.`;
  }
  for (const char of normalized) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      return "Display name contains unsupported characters.";
    }
  }
  const lowered = normalized.toLowerCase();
  if (
    normalized.includes("@") ||
    lowered.includes("://") ||
    lowered.includes("www.") ||
    lowered.startsWith("http")
  ) {
    return "Display name cannot contain links or handles.";
  }
  return null;
}

const GENERIC_FAILURE = "Couldn't change your name. Try again.";
const PROVIDER_UNAVAILABLE =
  "Hussh couldn't reach the sign-in service, so your name wasn't changed. Try again in a moment.";

function describeSaveError(error: unknown): string {
  if (error instanceof ApiError) {
    const code = apiErrorCode(error);
    if (error.status === 422 || code === "DISPLAY_NAME_INVALID") {
      return error.message || GENERIC_FAILURE;
    }
    if (error.status === 503 || code === "IDENTITY_PROVIDER_UNAVAILABLE") {
      return PROVIDER_UNAVAILABLE;
    }
    if (error.status === 401) {
      return error.message || "Sign in again to change your name.";
    }
    return error.message || GENERIC_FAILURE;
  }
  return GENERIC_FAILURE;
}

function storedDisplayName(
  identity: AccountIdentity | null | undefined,
): string | null {
  const value = String(identity?.display_name ?? "").trim();
  return value ? value : null;
}

export type DisplayNameEditorProps = {
  /** The signed-in Firebase user; the editor is inert without one. */
  user: User | null | undefined;
  /**
   * The name to show before any save completes. Defaults to the cached
   * identity's display name, then the Firebase user's.
   */
  initialDisplayName?: string | null;
  /** Called after a successful save; the parent usually pops the screen. */
  onSaved?: (identity: AccountIdentity | null) => void;
  /** Renders a Cancel control when provided. */
  onCancel?: () => void;
  className?: string;
};

export function DisplayNameEditor({
  user,
  initialDisplayName,
  onSaved,
  onCancel,
  className,
}: DisplayNameEditorProps) {
  const uid = user?.uid ?? null;
  const [shownName, setShownName] = useState<string>(() => {
    const cached = uid
      ? storedDisplayName(AccountIdentityService.peekCachedIdentity(uid)?.data)
      : null;
    return (
      String(initialDisplayName ?? "").trim() ||
      cached ||
      String(user?.displayName ?? "").trim()
    );
  });
  const [draft, setDraft] = useState(shownName);
  const [dirty, setDirty] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const inputId = useId();
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const mountedRef = useRef(true);
  const saveSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const normalizedDraft = normalizeDisplayName(draft);
  const validationError = validateDisplayName(draft);
  const unchanged = normalizedDraft === shownName;
  const showValidation = (dirty || submitted) && validationError !== null;
  const inlineError = serverError ?? (showValidation ? validationError : null);
  const canSave =
    Boolean(uid) && !saving && !unchanged && validationError === null;

  const applyServerIdentity = useCallback(
    (identity: AccountIdentity | null, options?: { toast?: boolean }) => {
      const stored = storedDisplayName(identity);
      if (!stored) return false;
      setShownName(stored);
      setDraft(stored);
      setDirty(false);
      setSubmitted(false);
      setServerError(null);
      if (options?.toast) {
        morphyToast.success(`Your Hussh name is now ${stored}.`);
      }
      return true;
    },
    [],
  );

  // A spoken "call me X" lands here as a tool result; the name on screen
  // updates from the server's stored value, and the identity cache is
  // re-read so the rest of the app agrees.
  useVoiceToolEffects({
    onToolResult: (tool, result) => {
      if (
        tool !== "update_display_name" ||
        (result.status !== "updated" && result.status !== "committed_sync_pending")
      )
        return;
      const spoken =
        typeof result.display_name === "string"
          ? result.display_name.trim()
          : "";
      if (spoken) {
        applyServerIdentity({ display_name: spoken });
      }
      if (!user) return;
      void AccountIdentityService.refreshCurrentUserIdentity(user, {
        force: true,
      })
        .then((identity) => {
          if (!mountedRef.current) return;
          applyServerIdentity(identity);
        })
        .catch(() => undefined);
    },
  });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (!user || saving) return;
    if (validationError !== null || unchanged) return;

    const seq = ++saveSeqRef.current;
    setSaving(true);
    try {
      const identity = await AccountIdentityService.updateDisplayName(
        user,
        normalizedDraft,
      );
      if (!mountedRef.current || seq !== saveSeqRef.current) return;
      const applied = applyServerIdentity(identity, { toast: true });
      if (!applied) {
        // The provider accepted the change but the response carried no name;
        // never echo the input as if it were confirmed.
        setServerError(
          "Saved, but Hussh couldn't read your new name back yet. Reopen this screen in a moment.",
        );
        return;
      }
      onSaved?.(identity);
    } catch (error) {
      if (!mountedRef.current || seq !== saveSeqRef.current) return;
      setServerError(describeSaveError(error));
    } finally {
      if (mountedRef.current && seq === saveSeqRef.current) setSaving(false);
    }
  };

  return (
    <form
      className={cn("flex flex-col gap-5", className)}
      noValidate
      onSubmit={(event) => void handleSubmit(event)}
      data-testid="display-name-editor"
    >
      <FieldGroup className="gap-5">
        <Field className="gap-2">
          <FieldLabel htmlFor={inputId}>Display name</FieldLabel>
          <Input
            id={inputId}
            name="display_name"
            type="text"
            autoComplete="name"
            autoCapitalize="words"
            spellCheck={false}
            enterKeyHint="done"
            value={draft}
            disabled={!uid || saving}
            aria-invalid={inlineError ? true : undefined}
            aria-describedby={inlineError ? `${helpId} ${errorId}` : helpId}
            onChange={(event) => {
              setDraft(event.target.value);
              setDirty(true);
              setServerError(null);
            }}
          />
          <FieldDescription
            id={helpId}
            className="flex items-baseline justify-between gap-3"
          >
            <span>
              {shownName
                ? `Shown to people you share with. Currently ${shownName}.`
                : "Shown to people you share with."}
            </span>
            <span
              className="tabular-nums text-muted-foreground"
              aria-hidden="true"
              data-testid="display-name-count"
            >
              {normalizedDraft.length}/{DISPLAY_NAME_MAX_LENGTH}
            </span>
          </FieldDescription>
          <FieldError id={errorId} data-testid="display-name-error">
            {inlineError}
          </FieldError>
        </Field>
      </FieldGroup>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        {onCancel ? (
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={onCancel}
            className="sm:min-w-[7.5rem]"
          >
            Cancel
          </Button>
        ) : null}
        <Button
          type="submit"
          disabled={!canSave}
          aria-busy={saving || undefined}
          className="sm:min-w-[7.5rem]"
          data-testid="display-name-save"
        >
          {saving ? (
            <>
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              Saving
            </>
          ) : (
            "Save name"
          )}
        </Button>
      </div>
    </form>
  );
}

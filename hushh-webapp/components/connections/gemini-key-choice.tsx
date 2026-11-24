"use client";

import { RadioGroup as RadioPrimitive } from "radix-ui";
import {
  CaretDownIcon,
  CheckCircleIcon as CheckCircle2,
  SpinnerGapIcon as Loader2,
} from "@/components/icons";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import {
  CardTitle,
  FormLabel,
  HelperText,
} from "@/components/app-ui/typography";
import { GeminiLogo } from "@/components/brand/gemini-logo";
import { GeminiFreeTierNote } from "./gemini-free-tier-note";
import { Badge } from "@/components/ui/badge";
import { Input, INPUT_CLASSNAME } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Button } from "@/lib/morphy-ux/button";
import type { GeminiRuntimeTransport } from "@/lib/services/personal-knowledge-model-service";

export type CredentialValidationState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; validatedAt: number; revision: number }
  | { status: "error"; message: string };

/** Key-entry presentation; validation and owner authority remain in Settings. */
export function GeminiKeyChoice({
  expanded,
  disabled = false,
  isSaving,
  isRemoving,
  privateCloud,
  placement,
  requiresExplicitSelection = false,
  useRadioItem,
  selectedOption,
  hasActiveGemini,
  hasSavedKey,
  needsVaultCreation,
  needsUnlock,
  draftLabel,
  transport,
  vertexProject,
  vertexLocation,
  draftKey,
  credentialValidation,
  onToggleExpand,
  onCancel,
  setDraftLabel,
  setTransport,
  setVertexProject,
  setVertexLocation,
  setDraftKey,
  invalidateCredentialValidation,
  saveByok,
  validateByok,
}: {
  expanded: boolean;
  disabled?: boolean;
  isSaving: boolean;
  isRemoving: boolean;
  privateCloud: boolean;
  placement: string;
  requiresExplicitSelection?: boolean;
  useRadioItem: boolean;
  selectedOption: string;
  hasActiveGemini: boolean;
  hasSavedKey: boolean;
  needsVaultCreation: boolean;
  needsUnlock: boolean;
  draftLabel: string;
  transport: GeminiRuntimeTransport;
  vertexProject: string;
  vertexLocation: string;
  draftKey: string;
  credentialValidation: CredentialValidationState;
  onToggleExpand: () => void;
  onCancel?: () => void;
  setDraftLabel: (value: string) => void;
  setTransport: (value: GeminiRuntimeTransport) => void;
  setVertexProject: (value: string) => void;
  setVertexLocation: (value: string) => void;
  setDraftKey: (value: string) => void;
  invalidateCredentialValidation: () => void;
  saveByok: () => Promise<void>;
  validateByok: () => Promise<void>;
}) {
  const rowDisabled =
    disabled || isSaving || isRemoving || (!privateCloud && placement !== "shared");
  return (
    <>
      <SettingsRow
        asChild
        leading={<GeminiLogo className="h-8 w-8" />}
        title="Gemini"
        disabled={rowDisabled}
        description={
          hasSavedKey
            ? "Add another Gemini configuration."
            : "Use your own key."
        }
        trailing={
          useRadioItem ? (
            <span
              aria-hidden
              className="flex size-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground"
            >
              {selectedOption === "byok" && (hasActiveGemini || expanded) ? (
                <span className="size-3 rounded-full bg-primary" />
              ) : null}
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              {hasActiveGemini ? <Badge variant="secondary">Active</Badge> : null}
              <CaretDownIcon
                aria-hidden
                className={cn(
                  "h-4 w-4 transition-transform",
                  expanded ? "rotate-180" : "",
                )}
              />
            </span>
          )
        }
        testId="profile-byok-runtime"
      >
        {useRadioItem ? (
          <RadioPrimitive.Item value="byok" disabled={rowDisabled} />
        ) : (
          <button
            type="button"
            disabled={rowDisabled}
            onClick={onToggleExpand}
            aria-expanded={expanded}
          />
        )}
      </SettingsRow>

      {expanded ? (
        <div className="space-y-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
          <div className="flex items-center justify-between gap-3">
            <CardTitle as="p">Gemini configuration</CardTitle>
            <Badge variant={hasSavedKey ? "secondary" : "outline"}>
              {needsVaultCreation
                ? "Vault needed"
                : needsUnlock
                  ? "Locked"
                  : hasSavedKey
                    ? "Saved"
                    : "New"}
            </Badge>
          </div>
          <Input
            type="text"
            autoComplete="off"
            value={draftLabel}
            onChange={(event) => setDraftLabel(event.target.value)}
            placeholder="Configuration name (optional, e.g. Work Gemini)"
            disabled={isSaving || isRemoving}
            aria-label="Gemini configuration name"
          />
          <FormLabel className="block space-y-1">
            API endpoint
            <select
              data-ui-role="input-text"
              value={transport}
              onChange={(event) => {
                setTransport(event.target.value as GeminiRuntimeTransport);
                invalidateCredentialValidation();
              }}
              disabled={
                isSaving ||
                isRemoving ||
                credentialValidation.status === "checking"
              }
              /* The SAME class the key field under it uses, so the two
                   stacked controls finally agree on radius, height, inset,
                   surface, border and focus ring — they were 24px/40px/12px
                   against 14px/44px/14px.

                   `appearance-none` is not cosmetic and is not optional. This
                   is a native <select>, and WebKit — the engine inside the iOS
                   app — draws `appearance: menulist` itself and OVERRIDES the
                   author's border-radius and padding. Measured in WebKit: the
                   select computes 5px against the input's 14px, and simply
                   handing it the input's classes leaves it at 5px. Without this
                   line the reported mismatch survives the fix on the only
                   platform most of our users are on.

                   `pr-9` then reserves the space the arrow used to get for
                   free, now that we are drawing the control ourselves. */
              className={cn(
                INPUT_CLASSNAME,
                "appearance-none bg-no-repeat pr-9",
              )}
              style={{
                // The disclosure arrow, drawn by us because appearance-none
                // removes the UA's. Inline because it is a data: URI keyed to
                // the label colour token, not a reusable utility.
                backgroundImage:
                  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'><path d='M1 1.5L6 6.5L11 1.5' stroke='%236e6e73' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
                backgroundPosition: "right 14px center",
              }}
            >
              <option value="developer_api">Google AI Studio</option>
              <option value="vertex_api_key">
                Google Cloud Vertex API key
              </option>
            </select>
          </FormLabel>
          <GeminiFreeTierNote transport={transport} />
          {transport === "vertex_api_key" ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                value={vertexProject}
                onChange={(event) => {
                  setVertexProject(event.target.value);
                  invalidateCredentialValidation();
                }}
                placeholder="Google Cloud project ID"
                disabled={isSaving || isRemoving}
                autoComplete="off"
                aria-label="Google Cloud project ID"
              />
              <Input
                value={vertexLocation}
                onChange={(event) => {
                  setVertexLocation(event.target.value);
                  invalidateCredentialValidation();
                }}
                placeholder="Vertex location, for example global"
                disabled={isSaving || isRemoving}
                autoComplete="off"
                aria-label="Vertex location"
              />
            </div>
          ) : null}
          <Input
            type="password"
            autoComplete="off"
            value={draftKey}
            onChange={(event) => {
              setDraftKey(event.target.value);
              invalidateCredentialValidation();
            }}
            placeholder={
              transport === "vertex_api_key"
                ? "Paste a Google Cloud Vertex API key"
                : "Paste a Google AI Studio Gemini key"
            }
            disabled={isSaving || isRemoving}
            aria-label="Gemini API key"
            aria-invalid={credentialValidation.status === "error"}
            aria-describedby="gemini-key-validation"
          />
          <HelperText
            as="div"
            className="min-h-5"
            id="gemini-key-validation"
            role={credentialValidation.status === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {credentialValidation.status === "checking" ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Checking key access and available quota…
              </span>
            ) : credentialValidation.status === "ready" ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                Key is responding and ready to save.
              </span>
            ) : credentialValidation.status === "error" ? (
              <span className="text-destructive">
                {credentialValidation.message}
              </span>
            ) : privateCloud ? (
              "Agent One checks and uses this key. It is sealed directly to your agent."
            ) : (
              "Validate the key before confirming it."
            )}
          </HelperText>
          <div className="flex flex-wrap gap-2">
            {credentialValidation.status === "ready" ? (
              <Button
                type="button"
                variant={requiresExplicitSelection ? "blue" : "blue-gradient"}
                onClick={() => void saveByok()}
                disabled={isSaving || isRemoving}
              >
                {isSaving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                ) : null}
                Confirm and save
              </Button>
            ) : (
              <Button
                type="button"
                variant={requiresExplicitSelection ? "blue" : "blue-gradient"}
                onClick={() => void validateByok()}
                disabled={
                  isSaving ||
                  isRemoving ||
                  credentialValidation.status === "checking"
                }
              >
                {credentialValidation.status === "checking" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                ) : null}
                {privateCloud ? "Check and use" : "Validate key"}
              </Button>
            )}
            {onCancel ? (
              <Button
                type="button"
                variant="none"
                effect="fade"
                onClick={onCancel}
                disabled={isSaving || isRemoving}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

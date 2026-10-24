"use client";

import { SettingsRow } from "@/components/app-ui/settings-ui";
import { GeminiLogo } from "@/components/brand/gemini-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/lib/morphy-ux/button";
import {
  SpinnerGapIcon as Loader2,
  TrashIcon as Trash2,
} from "@/components/icons";
import { UNVERIFIED_GEMINI_KEY_MESSAGE } from "@/lib/one/ai-selection-agent";
import type { RuntimeCredentialMode } from "@/lib/services/personal-knowledge-model-service";

export type CredentialValidationState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; validatedAt: number; revision: number }
  | { status: "error"; message: string };

/** Unavailable key processing; a previously saved key remains removable. */
export function GeminiKeyChoice({
  isSaving,
  isRemoving,
  mode,
  otherProvider,
  hasSavedKey,
  removeByok,
}: {
  isSaving: boolean;
  isRemoving: boolean;
  mode: RuntimeCredentialMode;
  otherProvider: boolean;
  hasSavedKey: boolean;
  removeByok: () => Promise<void>;
}) {
  return (
    <>
      <SettingsRow
        leading={<GeminiLogo className="h-8 w-8" />}
        title="Gemini"
        description={UNVERIFIED_GEMINI_KEY_MESSAGE}
        disabled
        trailing={<Badge variant="secondary">Unavailable</Badge>}
        testId="profile-byok-runtime"
      />
      {mode === "byok" && !otherProvider && hasSavedKey ? (
        <div className="px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
          <Button
            type="button"
            variant="none"
            effect="fade"
            onClick={() => void removeByok()}
            disabled={isSaving || isRemoving}
          >
            {isRemoving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" aria-hidden />
            )}
            Remove key
          </Button>
        </div>
      ) : null}
    </>
  );
}

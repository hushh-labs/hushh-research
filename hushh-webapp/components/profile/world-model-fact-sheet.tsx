"use client";

import { useCallback, useState } from "react";
import { SettingsDetailPanel } from "@/components/profile/settings-ui";
import { HelperText, RowDescription, SectionLabel } from "@/components/app-ui/typography";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/lib/morphy-ux/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import type { PwmClaim, PwmTopic } from "@/lib/services/world-model-decision-service";
import type { ProfileReport } from "@/lib/services/profile-research-service";

export type WorldModelDraftFact = {
  kind: "draft";
  key: string;
  statement: string;
  topic: PwmTopic;
  confidence: "supported" | "uncertain" | "conflicting";
  evidenceScore?: number;
  evidenceReason?: string;
  /** Whether the report is about this owner, not someone with the same name. */
  matchStatus: ProfileReport["match_status"];
  sources: readonly { title: string; url: string }[];
  reason: string;
};
export type WorldModelFactDetail =
  | WorldModelDraftFact
  | { kind: "saved"; claim: PwmClaim; edit?: boolean };

export type WorldModelFactActions = {
  confirm: (fact: WorldModelDraftFact) => Promise<void>;
  reject: (fact: WorldModelDraftFact) => Promise<void>;
  edit: (fact: WorldModelFactDetail, text: string) => Promise<void>;
  remove: (claim: PwmClaim) => Promise<void>;
};

const MAX_STATEMENT_CHARS = 600;
const CERTAINTY = {
  supported: "Check the linked page before saving this statement.",
  uncertain: "Possible match. The sources only hint at this.",
  conflicting: "The sources disagree. Check before you say yes.",
} as const;

/** Matches the row's Possible match tag: an uncertain match outranks source confidence. */
function certainty(fact: WorldModelDraftFact): string {
  if (fact.matchStatus !== "matched")
    return "Possible match. This may be about someone else with your name.";
  if (fact.evidenceScore !== undefined && fact.evidenceScore <= 5)
    return "The public evidence is limited. Check this before you say yes.";
  return CERTAINTY[fact.confidence];
}

/** Sources, certainty and owner choices for one statement; closes only after a committed write. */
export function WorldModelFactSheet({
  fact,
  title,
  pathname,
  actions,
  pending = false,
  present = true,
  backQuery,
  onClose,
}: {
  fact: WorldModelFactDetail;
  title: string;
  pathname: string;
  actions: WorldModelFactActions;
  /** A decision for this statement is already saving, from its row or here. */
  pending?: boolean;
  present?: boolean;
  backQuery?: Readonly<Record<string, string>>;
  onClose: () => void;
}) {
  const text = fact.kind === "draft" ? fact.statement : fact.claim.text;
  const [mode, setMode] = useState<"view" | "edit" | "remove">(fact.kind === "saved" && fact.edit ? "edit" : "view");
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // One decision per statement at a time: a save from the row locks this sheet too.
  const locked = busy || pending;
  const run = async (action: () => Promise<void>) => {
    if (locked) return;
    setBusy(true);
    setFailed(false);
    try {
      await action();
      onClose();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  const back = useCallback(() => {
    if (busy) return true;
    if (mode !== "view") {
      setMode("view");
      setDraft(text);
      setFailed(false);
      return true;
    }
    onClose();
    return true;
  }, [busy, mode, text, onClose]);
  useBackLayer(pathname, present ? mode === "view" ? 1 : 2 : 0, back, backQuery);
  const trimmed = draft.trim();

  return (
    <SettingsDetailPanel
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={title}
      mobilePresentation="sheet"
    >
      <div className="min-w-0 space-y-4 py-2">
        <p className="ui-text-row-label break-words [overflow-wrap:anywhere]">{text}</p>
        {fact.kind === "draft" ? (
          <>
            <section className="space-y-1">
              <SectionLabel as="h3" compact>Sources</SectionLabel>
              <ul className="space-y-0">
                {fact.sources.map((source) => (
                  <li key={source.url}>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ui-text-row-description inline-flex min-h-11 items-center break-words underline underline-offset-4 [overflow-wrap:anywhere]"
                    >
                      {source.title}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
            {fact.reason ? (
              <section className="space-y-1">
                <SectionLabel as="h3" compact>Why this may be you</SectionLabel>
                <RowDescription className="break-words [overflow-wrap:anywhere]">{fact.reason}</RowDescription>
              </section>
            ) : null}
            <RowDescription>{certainty(fact)}</RowDescription>
            {fact.evidenceScore ? (
              <RowDescription>
                Source trail: {fact.evidenceReason}
              </RowDescription>
            ) : null}
          </>
        ) : (
          <RowDescription>
            Confirmed on{" "}
            {new Date(fact.claim.decided_at).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </RowDescription>
        )}
        {mode === "edit" ? (
          <div className="space-y-2">
            <Textarea
              aria-label="Corrected wording"
              value={draft}
              maxLength={MAX_STATEMENT_CHARS}
              disabled={locked}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="compact"
                data-voice-control-id="pwm_fact_edit_save"
                disabled={locked || !trimmed || trimmed === text.trim() || trimmed.length > MAX_STATEMENT_CHARS}
                onClick={() => void run(() => actions.edit(fact, trimmed))}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button size="compact" variant="none" disabled={busy} onClick={back}>
                Cancel
              </Button>
            </div>
          </div>
        ) : mode === "remove" && fact.kind === "saved" ? (
          <div className="space-y-2">
            <p className="ui-text-row-label">Remove this detail?</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="compact"
                variant="destructive"
                data-voice-control-id="pwm_fact_remove_confirm"
                disabled={busy}
                onClick={() => void run(() => actions.remove(fact.claim))}
              >
                {busy ? "Removing…" : "Remove"}
              </Button>
              <Button size="compact" variant="none" disabled={busy} onClick={back}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {fact.kind === "draft" ? (
              <>
                <Button
                  size="compact"
                  variant="muted"
                  disabled={locked}
                  data-voice-control-id="pwm_fact_yes"
                  aria-label={`Yes, this is right: ${fact.statement}`}
                  onClick={() => void run(() => actions.confirm(fact))}
                >
                  Yes
                </Button>
                <Button
                  size="compact"
                  variant="none"
                  disabled={locked}
                  data-voice-control-id="pwm_fact_no"
                  aria-label={`No, this isn’t right: ${fact.statement}`}
                  onClick={() => void run(() => actions.reject(fact))}
                >
                  No
                </Button>
              </>
            ) : null}
            <Button
              size="compact"
              variant="none"
              disabled={locked}
              data-voice-control-id="pwm_fact_edit"
              onClick={() => setMode("edit")}
            >
              Edit
            </Button>
            {fact.kind === "saved" ? (
              <Button
                size="compact"
                variant="none"
                disabled={busy}
                data-voice-control-id="pwm_fact_remove"
                onClick={() => setMode("remove")}
              >
                Remove
              </Button>
            ) : null}
          </div>
        )}
        {locked && mode === "view" ? <HelperText role="status">Saving…</HelperText> : null}
        {failed ? <HelperText role="status">Couldn’t save. Try again.</HelperText> : null}
      </div>
    </SettingsDetailPanel>
  );
}

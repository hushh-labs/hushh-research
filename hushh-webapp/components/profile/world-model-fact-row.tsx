"use client";

import { SettingsRow } from "@/components/profile/settings-ui";
import { HelperText } from "@/components/app-ui/typography";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/lib/morphy-ux/button";

/** One short Personal World Model statement with its owner decision controls. */
export function WorldModelFactRow({
  factKey,
  statement,
  meta,
  unsure,
  undecided,
  saving,
  failed,
  onYes,
  onNo,
  onOpen,
}: {
  /** Stable statement key; focus moves to the next row's Yes after a decision. */
  factKey?: string;
  statement: string;
  /** Source title or decision; never blank for a doubtful match (the page falls back). */
  meta: string;
  /** Tagged "Possible match": doubtful evidence or a doubtful match. */
  unsure: boolean;
  undecided: boolean;
  saving: boolean;
  failed: boolean;
  onYes: () => void;
  onNo: () => void;
  onOpen: () => void;
}) {
  return (
    <SettingsRow
      title={<span className="line-clamp-2 [overflow-wrap:anywhere]">{statement}</span>}
      description={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 [overflow-wrap:anywhere]">{meta}</span>
          {unsure ? <Badge variant="secondary">Possible match</Badge> : null}
        </span>
      }
      onClick={onOpen}
      chevron={!undecided}
      voiceControlId="pwm_fact_open"
      voiceLabel={statement}
      voicePurpose="Opens sources and choices for this detail."
      stackTrailingOnMobile={undecided}
      trailingInteractive={undecided}
      className="[--settings-row-stack-indent:0px]"
      testId="pwm-fact-row"
      trailing={
        undecided ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="compact"
              variant="muted"
              disabled={saving}
              aria-label={`Yes, this is right: ${statement}`}
              data-voice-control-id="pwm_fact_yes"
              data-pwm-fact-yes={factKey}
              onClick={onYes}
            >
              Yes
            </Button>
            <Button
              size="compact"
              variant="none"
              disabled={saving}
              aria-label={`No, this isn’t right: ${statement}`}
              data-voice-control-id="pwm_fact_no"
              onClick={onNo}
            >
              No
            </Button>
            {saving ? <HelperText role="status">Saving…</HelperText> : null}
            {failed && !saving ? (
              <HelperText role="status">Couldn’t save. Try again.</HelperText>
            ) : null}
          </div>
        ) : undefined
      }
    />
  );
}

"use client";

import { useId } from "react";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { Bell } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAttemptEmail } from "./use-attempt-email";

export function AttemptEmailPanel({ owner }: { owner: string | null }) {
  const model = useAttemptEmail(owner);
  const descriptionId = useId();
  const disclosureId = useId();
  const hasChanges = !!model.value && model.enabledDraft !== model.value.enabled;
  const showDisclosure = hasChanges && model.enabledDraft;
  const canEnable = model.value?.available === true;
  return (
    <form aria-label="Activity emails" onSubmit={(event) => {
      event.preventDefault();
      if (hasChanges) void model.save(model.enabledDraft);
    }}>
      <SettingsRow
        icon={Bell}
        iconTone="capability"
        title="Activity emails"
        description={<>
          <span id={descriptionId}>
            One status email per recorded agent attempt.
            {model.value && !canEnable ? (
              <span className="block">
                {model.value.enabled ? "Unavailable now. You can still turn emails off." : "Unavailable for this account."}
              </span>
            ) : null}
          </span>
          {model.loading ? <span role="status" className="block">Loading preference…</span> : null}
          {model.error ? <span role="alert" className="block">{model.error}</span> : null}
        </>}
        trailing={model.value ? (
          <Switch
            size="ios"
            className="relative after:absolute after:inset-x-0 after:-inset-y-2"
            data-voice-control-id="one_attempt_email_enabled"
            aria-label="Activity emails"
            aria-describedby={showDisclosure ? `${descriptionId} ${disclosureId}` : descriptionId}
            checked={model.enabledDraft}
            disabled={model.busy || !canEnable && !model.enabledDraft}
            onCheckedChange={model.edit}
          />
        ) : !model.loading ? (
          <Button data-voice-control-id="one_attempt_email_retry" type="button" variant="link" className="min-h-11 px-2" aria-label="Retry activity email choice" onClick={() => void model.refresh()}>
            Retry
          </Button>
        ) : null}
      />
      {showDisclosure ? (
        <p id={disclosureId} className="px-4 pb-1 text-xs text-muted-foreground">
          Prompts and results stay private. Emails may be delayed or missed. Check the app for outcomes. Unsubscribe anytime.
        </p>
      ) : null}
      {hasChanges || model.busy ? (
        <div className="flex justify-end px-4 pb-1">
          <Button data-voice-control-id="one_attempt_email_save" type="submit" variant="link" className="min-h-11 px-2" disabled={model.busy} aria-label="Save activity email choice">
            {model.busy ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
      <span role="status" className="sr-only">{model.saved ? "Activity email choice saved." : ""}</span>
    </form>
  );
}

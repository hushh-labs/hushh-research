"use client";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAttemptEmail } from "./use-attempt-email";

export function AttemptEmailPanel({ owner }: { owner: string | null }) {
  const model = useAttemptEmail(owner);
  return <section aria-label="Optional activity emails" className="rounded-xl border p-4 text-left space-y-3">
    <h2 className="text-sm font-medium">Activity emails (optional)</h2>
    <p className="text-sm text-muted-foreground">Receive one email when an agent attempt reports its outcome. Emails include the agent, action and reported status, without your prompts or results. You can turn them off here or unsubscribe in any activity email.</p>
    <p className="text-sm text-muted-foreground">Some attempts may not be recorded. Delivery can be delayed; an email does not confirm that an external action succeeded.</p>
    {model.loading ? <p role="status">Loading saved choice…</p> : null}
    {model.error ? <p role="alert">{model.error}</p> : null}
    {model.value ? <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void model.save(model.enabledDraft); }}>
      {!model.value.available ? <p role="status">Activity emails are not available for this account yet. You can still turn off your saved choice.</p> : null}
      <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
        Email me once per agent attempt
        <Switch data-voice-control-id="one_attempt_email_enabled" aria-label="Email me once per agent attempt" checked={model.enabledDraft}
          disabled={model.busy || !model.value.available && !model.enabledDraft} onCheckedChange={model.edit} />
      </label>
      <Button data-voice-control-id="one_attempt_email_save" type="submit" variant="outline" disabled={model.busy || model.enabledDraft === model.value.enabled}>
        {model.busy ? "Saving…" : "Save activity email choice"}
      </Button>
      {model.saved ? <p role="status">Activity email choice saved.</p> : null}
    </form> : !model.loading ? <Button data-voice-control-id="one_attempt_email_retry" type="button" variant="outline" onClick={() => void model.refresh()}>Refresh activity email choice</Button> : null}
  </section>;
}

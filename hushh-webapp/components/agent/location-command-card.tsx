"use client";

import { useState } from "react";
import { ChevronDown } from "@/components/icons";
import { useLocationCommand } from "./location-command-provider";
import { useOptionalOneLocationInteractionSurface } from "@/components/one-location/onboarding/location-onboarding-interaction-surface";

/** Only real choices and required actions expand; no modal or page-wide backdrop. */
export function LocationCommandCard() {
  const {
    view,
    command,
    run,
    cancelTask,
    dismissResult,
    collapsed,
    setCollapsed,
    workflowResult,
  } = useLocationCommand();
  const locationSurface = useOptionalOneLocationInteractionSurface();
  const [input, setInput] = useState("");
  if (view.phase === "idle" || view.phase === "working" || collapsed)
    return null;
  return (
    <div
      className="agent-approval-glass pointer-events-auto max-h-[min(40dvh,24rem)] w-full overflow-y-auto rounded-3xl p-4"
      role="region"
      aria-label="Location command"
    >
      <button
        type="button"
        aria-label="Collapse command"
        className="float-right rounded-full p-2"
        onClick={() => setCollapsed(true)}
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      {view.gate?.choices?.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="my-1 block w-full rounded-xl border p-3 text-left"
          onClick={(event) =>
            run(command.chooseResource(choice.id, event.nativeEvent.isTrusted))
          }
        >
          <span className="block">{choice.label}</span>
          {choice.detail ? (
            <span className="text-xs text-muted-foreground">
              {choice.detail}
            </span>
          ) : null}
        </button>
      ))}
      {view.transcript ? (
        <p className="mb-2 text-sm text-muted-foreground">{view.transcript}</p>
      ) : null}
      {view.actionLabel ? (
        <p className="font-semibold">{view.actionLabel}</p>
      ) : null}
      {workflowResult && locationSurface?.commandPresentation ? (
        locationSurface.commandPresentation
      ) : (
        <p className="text-sm" role="status" aria-live="polite">
          {view.message}
        </p>
      )}
      {view.gate?.kind === "input" ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            run(command.resolve(input));
            setInput("");
          }}
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            aria-label="Missing Location detail"
            className="min-w-0 flex-1 rounded-xl border bg-background px-3 py-2"
            autoComplete="off"
          />
          <button
            type="submit"
            className="rounded-xl bg-primary px-3 text-primary-foreground"
          >
            Continue
          </button>
        </form>
      ) : null}
      {view.gate &&
      ["confirmation", "permission", "navigation"].includes(view.gate.kind) ? (
        <button
          type="button"
          className="mt-3 w-full rounded-full bg-primary py-3 text-primary-foreground"
          onClick={(event) =>
            run(command.continueGate(event.nativeEvent.isTrusted))
          }
        >
          {view.gate.kind === "confirmation" ? "Confirm" : "Continue"}
        </button>
      ) : null}
      {view.gate?.kind === "unavailable" && command.hasActiveCheckpoint ? (
        <button
          type="button"
          className="mt-3 w-full rounded-full bg-primary py-3 text-primary-foreground"
          onClick={() => run(command.refresh())}
        >
          Refresh / Resume
        </button>
      ) : null}
      {view.recoverable?.map((pending) => (
        <div
          key={pending.command_id}
          className="mt-3 flex items-center gap-3 text-sm"
        >
          <span className="flex-1">
            Step {pending.next_step + 1} of {pending.step_count || 1}
          </span>
          <button
            onClick={() => run(command.resume(pending))}
            className="rounded-full bg-primary px-4 py-2 text-primary-foreground"
          >
            Resume
          </button>
          <button onClick={() => run(command.cancel(pending))}>Cancel</button>
        </div>
      ))}
      {view.phase !== "recovery" ? (
        <button
          type="button"
          className="mt-3 text-sm text-muted-foreground"
          onClick={() => {
            if (view.phase === "result") dismissResult();
            else cancelTask();
          }}
        >
          {view.phase === "result" ? "Dismiss result" : command.hasActiveCheckpoint ? "Cancel task" : "Dismiss"}
        </button>
      ) : null}
    </div>
  );
}

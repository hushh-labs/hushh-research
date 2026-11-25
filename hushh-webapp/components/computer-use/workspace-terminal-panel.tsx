"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Code2, Lock, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiService } from "@/lib/services/api-service";
import { morphyToast } from "@/lib/morphy-ux/morphy";

const DEFAULT_WORKSPACE_ID = "ws_default";

type WorkspaceExecutionEvent = Readonly<{
  seq: number;
  timestamp_ms?: number;
  actor?: string;
  command_summary?: string;
  status?: string;
  exit_code?: number;
  code?: string;
}>;

type WorkspaceStatusState = Readonly<{
  controlMode: "agent" | "owner";
  controlEpoch: number;
  boundaryMode?: string;
  pressureLevel?: string;
  events: readonly WorkspaceExecutionEvent[];
}>;

function tokenizeCommand(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === undefined) continue;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (quote) {
    throw new Error("UNCLOSED_QUOTE");
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

/** On-demand terminal session panel for the unified sandbox runtime. Zero idle polling. */
export function WorkspaceTerminalPanel({
  podId,
  active,
}: {
  podId?: string;
  active: boolean;
}) {
  const [status, setStatus] = useState<WorkspaceStatusState | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailableMessage, setUnavailableMessage] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setUnavailableMessage(null);
    try {
      const response = await ApiService.ownerPodRequest(
        `files/workspaces/status?workspace_id=${DEFAULT_WORKSPACE_ID}`,
        { method: "GET", cache: "no-store", signal },
        false,
        undefined,
        podId,
      );
      if (signal?.aborted) return;
      if (!response.ok) {
        setStatus(null);
        setUnavailableMessage(
          response.status === 404 || response.status === 503
            ? "Terminal is available when connected to your sandbox workspace."
            : "Couldn't read sandbox terminal state right now.",
        );
        return;
      }
      const data = (await response.json()) as {
        control_mode?: unknown;
        control_epoch?: unknown;
        boundary_mode?: unknown;
        pressure?: { level?: unknown };
        events?: unknown;
      };
      if (signal?.aborted) return;
      setStatus({
        controlMode: data.control_mode === "owner" ? "owner" : "agent",
        controlEpoch: typeof data.control_epoch === "number" ? data.control_epoch : 0,
        boundaryMode: typeof data.boundary_mode === "string" ? data.boundary_mode : undefined,
        pressureLevel:
          data.pressure && typeof data.pressure.level === "string"
            ? data.pressure.level
            : undefined,
        events: Array.isArray(data.events)
          ? (data.events as WorkspaceExecutionEvent[]).slice(-12).reverse()
          : [],
      });
    } catch {
      if (!signal?.aborted) {
        setUnavailableMessage("Terminal is available when connected to your sandbox workspace.");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [podId]);

  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    void loadStatus(abort.signal);
    return () => abort.abort();
  }, [active, loadStatus]);

  async function toggleControl(action: "take_control" | "resume_agent"): Promise<void> {
    setSubmitting(true);
    try {
      const response = await ApiService.ownerPodRequest(
        "files/workspaces/control",
        {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: DEFAULT_WORKSPACE_ID,
            action,
            request_id: crypto.randomUUID(),
          }),
        },
        false,
        undefined,
        podId,
      );
      if (!response.ok) {
        morphyToast.error("Couldn't update terminal control right now.");
        return;
      }
      await loadStatus();
      morphyToast.info(
        action === "take_control" ? "You're in control of the terminal." : "Agent resumed.",
      );
    } catch {
      morphyToast.error("Couldn't update terminal control right now.");
    } finally {
      setSubmitting(false);
    }
  }

  async function runOwnerCommand(event: FormEvent): Promise<void> {
    event.preventDefault();
    const raw = commandInput.trim();
    if (!raw || submitting || status?.controlMode !== "owner") return;
    let argv: string[];
    try {
      argv = tokenizeCommand(raw);
    } catch {
      morphyToast.error("Close open quotes before running the command.");
      return;
    }
    if (!argv.length) return;
    setSubmitting(true);
    try {
      const response = await ApiService.ownerPodRequest(
        "files/workspaces/execute",
        {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: DEFAULT_WORKSPACE_ID,
            argv,
            actor: "owner",
            timeout_seconds: 30,
            request_id: crypto.randomUUID(),
          }),
        },
        false,
        undefined,
        podId,
      );
      if (!response.ok) {
        morphyToast.error("Couldn't execute that command in the sandbox.");
        return;
      }
      setCommandInput("");
      await loadStatus();
    } catch {
      morphyToast.error("Couldn't execute that command in the sandbox.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="workspace-terminal-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-default-solid)] px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <Code2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="font-medium text-foreground">
            {status?.controlMode === "owner" ? "You are in control" : "Agent active"}
          </span>
          {status?.pressureLevel ? (
            <span className="text-xs text-muted-foreground">({status.pressureLevel})</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status ? (
            status.controlMode === "owner" ? (
              <Button
                type="button"
                size="sm"
                className="px-3.5"
                disabled={submitting}
                onClick={() => {
                  void toggleControl("resume_agent");
                }}
              >
                Resume agent
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="px-3.5 font-medium"
                disabled={submitting}
                onClick={() => {
                  void toggleControl("take_control");
                }}
              >
                Take control
              </Button>
            )
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="subdued"
            className="px-3.5"
            disabled={loading}
            aria-label="Refresh terminal status"
            onClick={() => {
              void loadStatus();
            }}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Refresh
          </Button>
        </div>
      </div>

      {unavailableMessage ? (
        <p className="text-sm text-muted-foreground" role="status">
          {unavailableMessage}
        </p>
      ) : null}

      {status ? (
        <>
          <div className="space-y-2 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] bg-[color:var(--app-neutral-fill)]/55 p-3">
            {status.controlMode === "owner" ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="size-3.5 shrink-0" aria-hidden />
                Private terminal entry active. Command outputs are withheld from transcripts.
              </p>
            ) : null}
            {status.events.length ? (
              <ul className="space-y-1.5 text-xs">
                {status.events.map((item) => (
                  <li
                    key={item.seq}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--app-separator)] pb-1.5 last:border-b-0 last:pb-0"
                  >
                    <span className="font-mono text-[12px] text-foreground">
                      {item.command_summary || `step #${item.seq}`}
                    </span>
                    <span className="tabular-nums text-[11.5px] text-muted-foreground">
                      {item.actor ?? "agent"} · {item.status ?? "done"}
                      {typeof item.exit_code === "number" ? ` (exit ${item.exit_code})` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                No terminal commands run in this session yet.
              </p>
            )}
          </div>

          <form
            onSubmit={(event) => {
              void runOwnerCommand(event);
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <Input
              aria-label="Terminal command"
              value={commandInput}
              onChange={(event) => setCommandInput(event.target.value)}
              disabled={status.controlMode !== "owner" || submitting}
              placeholder={
                status.controlMode === "owner"
                  ? "Enter command to run in sandbox..."
                  : "Take control to run a manual command"
              }
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-9 min-w-0 flex-1 rounded-full font-mono text-xs"
            />
            <Button
              type="submit"
              size="sm"
              className="px-4"
              disabled={status.controlMode !== "owner" || submitting || !commandInput.trim()}
            >
              Run
            </Button>
          </form>
        </>
      ) : null}
    </div>
  );
}

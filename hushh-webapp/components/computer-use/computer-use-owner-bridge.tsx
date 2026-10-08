"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { ComputerUseClient } from "@/lib/services/computer-use-client";
import type { ComputerUseSnapshot } from "@/lib/computer-use/contracts";
import { ComputerUseTaskCard } from "./computer-use-task-card";

/** Opening is an owner action: mounting One never wakes a pod just to check a pilot. */
export function ComputerUseOwnerBridge({ ownerId }: { ownerId: string }) {
  const client = useMemo(() => new ComputerUseClient(ownerId), [ownerId]);
  const transport = useMemo(() => client.transport(), [client]);
  const [phase, setPhase] = useState<"closed" | "checking" | "unavailable" | "ready" | "starting" | "active">("closed");
  const [task, setTask] = useState<ComputerUseSnapshot | null>(null);
  const [website, setWebsite] = useState("");
  const [goal, setGoal] = useState("");
  const pending = useRef<AbortController | null>(null);
  const attempt = useRef<{ requestId: string; goal: string; origin: string } | null>(null);

  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
    attempt.current = null;
  }, [client]);

  async function check(): Promise<void> {
    if (pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setPhase("checking");
    try {
      const capability = await client.capability(request.signal);
      if (!request.signal.aborted) setPhase(capability.available ? "ready" : "unavailable");
    } catch {
      if (!request.signal.aborted) setPhase("unavailable");
    } finally { if (pending.current === request) pending.current = null; }
  }

  async function start(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending.current || phase !== "ready") return;
    let site: URL;
    try {
      site = new URL(website);
      if (site.protocol !== "https:" || site.username || site.password || site.hash) throw new Error();
    } catch {
      morphyToast.error("Enter a secure website address.");
      return;
    }
    const instruction = goal.trim();
    if (!instruction || instruction.length > 4096) return;
    const previous = attempt.current;
    const terms = previous?.goal === instruction && previous.origin === site.origin ? previous
      : { requestId: crypto.randomUUID(), goal: instruction, origin: site.origin };
    attempt.current = terms;
    const request = new AbortController();
    pending.current = request;
    setPhase("starting");
    const operation = client.start({ requestId: terms.requestId, goal: terms.goal, allowedOrigins: [terms.origin] }, request.signal);
    morphyToast.promise(operation, {
      loading: "Preparing the browser…", success: "Browser task created.",
      error: "Couldn’t start the browser. Try again in a moment.",
    });
    try {
      const created = await operation;
      if (!request.signal.aborted) {
        setTask(created);
        setGoal("");
        setWebsite("");
        attempt.current = null;
        setPhase("active");
      }
    } catch {
      if (!request.signal.aborted) setPhase("ready");
    } finally { if (pending.current === request) pending.current = null; }
  }

  if (phase === "active" && task) return <ComputerUseTaskCard binding={task.binding} transport={transport} />;
  if (phase === "closed") return (
    <div className="flex justify-end">
      <ShellActionSurface variant="pill" className="min-h-11" onClick={() => { void check(); }}>Browser</ShellActionSurface>
    </div>
  );
  return (
    <section className="space-y-3 rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] p-4" aria-label="Browser task setup" aria-busy={phase === "checking" || phase === "starting"}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Browser</h3>
        <ShellActionSurface variant="pill" className="min-h-11" disabled={phase === "checking" || phase === "starting"}
          onClick={() => setPhase("closed")}>Close</ShellActionSurface>
      </div>
      {phase === "checking" ? <p className="text-sm text-muted-foreground" role="status">Checking browser availability…</p>
        : phase === "unavailable" ? <p className="text-sm text-muted-foreground" role="status">Browser isn’t available on this private agent yet.</p>
        : <form onSubmit={(event) => { void start(event); }} className="space-y-[var(--app-form-section-gap)]">
          <div className="space-y-[var(--app-form-field-gap)]">
            <label className="block text-sm" htmlFor={`browser-site-${ownerId}`}>Website</label>
            <Input id={`browser-site-${ownerId}`} type="url" value={website} onChange={(event) => setWebsite(event.target.value)}
              required autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="https://example.com" disabled={phase === "starting"} />
          </div>
          <div className="space-y-[var(--app-form-field-gap)]">
            <label className="block text-sm" htmlFor={`browser-goal-${ownerId}`}>What should One do?</label>
            <Textarea id={`browser-goal-${ownerId}`} value={goal} onChange={(event) => setGoal(event.target.value)}
              required maxLength={4096} rows={2} autoComplete="off" disabled={phase === "starting"} />
          </div>
          <ShellActionSurface type="submit" variant="pill" className="min-h-11" disabled={phase === "starting" || !goal.trim() || !website.trim()}>
            Start browser task
          </ShellActionSurface>
        </form>}
    </section>
  );
}

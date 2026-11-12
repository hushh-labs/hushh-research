const owners = new Set<object>();
const subscribers = new Set<() => void>();

export type NativeWorkspacePhase = "checking" | "native" | "web" | "blocked";
export type NativeWorkspaceReason = "admission" | "active" | "inactive" | "unsupported" | "failure" | "web-overlay";
export type NativeWorkspacePresentationStatus = {
  identity: object | null;
  phase: NativeWorkspacePhase;
  reason: NativeWorkspaceReason;
  held: boolean;
};
type Lifetime = { phase: NativeWorkspacePhase; reason: NativeWorkspaceReason; retire: (reason?: NativeWorkspaceReason) => Promise<boolean> };

/** Route-local ownership of shared workspace lifetimes. Old completions may
 * release only their own entry, including after the feature unmounts. */
export class NativeWorkspacePresentationOwner {
  private lifetimes = new Map<object, Lifetime>();
  private listeners = new Set<() => void>();
  private latest: object | null = null;
  private terminal: Pick<NativeWorkspacePresentationStatus, "identity" | "phase" | "reason"> = { identity: null, phase: "web", reason: "inactive" };
  private snapshot: NativeWorkspacePresentationStatus = { identity: null, phase: "web", reason: "inactive", held: false };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  register(identity: object, retire: Lifetime["retire"]) {
    this.latest = identity;
    this.lifetimes.set(identity, { phase: "checking", reason: "admission", retire });
    this.publish();
  }

  report(identity: object, phase: NativeWorkspacePhase, reason: NativeWorkspaceReason) {
    const lifetime = this.lifetimes.get(identity);
    if (!lifetime) return;
    lifetime.phase = phase; lifetime.reason = reason;
    if (phase === "web") this.lifetimes.delete(identity);
    if (identity === this.latest) this.terminal = { identity, phase, reason };
    this.publish();
  }

  /** New admission waits for every preceding native lifetime to leave. */
  async retirePredecessors(identity: object) {
    const predecessors = [...this.lifetimes].filter(([key]) => key !== identity);
    const results = await Promise.all(predecessors.map(([, value]) => value.retire("inactive").catch(() => false)));
    return results.every(Boolean);
  }

  retireForWeb = async () => {
    const results = await Promise.all([...this.lifetimes.values()].map(value => value.retire("web-overlay").catch(() => false)));
    return results.every(Boolean) && this.lifetimes.size === 0;
  };

  private publish() {
    const current = this.latest ? this.lifetimes.get(this.latest) : undefined;
    const held = this.lifetimes.size > 0;
    const next = current ? { identity: this.latest, phase: current.phase, reason: current.reason, held }
      : { ...this.terminal, held };
    // An older uncertain retirement continues to cover the Web replacement.
    if (held && next.phase === "web") { next.phase = "blocked"; next.reason = "inactive"; }
    if (Object.keys(next).every(key => next[key as keyof typeof next] === this.snapshot[key as keyof typeof next])) return;
    this.snapshot = next;
    this.listeners.forEach(listener => listener());
  }
}

export function nativeWorkspacePresentationActive() {
  return owners.size > 0;
}

export function subscribeNativeWorkspacePresentation(listener: () => void) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

/** Track a native owner from its first apply attempt until exact retirement. */
export function setNativeWorkspacePresentationOwner(identity: object, active: boolean) {
  const changed = active ? !owners.has(identity) : owners.has(identity);
  if (!changed) return;
  if (active) owners.add(identity);
  else owners.delete(identity);
  subscribers.forEach(listener => listener());
}

let shellFeedbackAvailable = false;
export function nativeShellFeedbackAvailable() { return shellFeedbackAvailable; }
export function setNativeShellFeedbackAvailable(available: boolean) {
  if (shellFeedbackAvailable === available) return;
  shellFeedbackAvailable = available;
  subscribers.forEach(listener => listener());
}

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentVoiceClient } from "@/lib/services/agent-voice-client";

/**
 * Characterization: resilient object construction of the public voice-capture
 * client under empty / incomplete / null configuration.
 *
 * TRUTH CORRECTION — read before trusting the original task title
 * --------------------------------------------------------------
 * The requested target, a `DataVitalTracker` initialization helper / class
 * constructor, DOES NOT EXIST anywhere in this repository. A repo-wide search
 * for `DataVitalTracker` returns zero results, and there is no exported "vital"
 * tracker class under `hushh-webapp/lib/services`. Writing a test that imports a
 * fictional symbol would not compile and would document nothing real.
 *
 * The closest REAL, exported, instantiable service-layer surface whose premise
 * actually matches ("build a resilient instance from missing configuration
 * rather than breaking the sequence") is `AgentVoiceClient`
 * (hushh-webapp/lib/services/agent-voice-client.ts). This suite therefore
 * characterizes THAT shipped contract truthfully.
 *
 * A second premise correction: `AgentVoiceClient` has NO constructor parameter.
 * `new AgentVoiceClient()` is zero-arg — there is no config dictionary, so there
 * is nothing to pass as empty / null at construction time. What the class DOES
 * guarantee is a resilient, fully-initialized idle instance whose lifecycle
 * mutators tolerate being called before `start()` and with an empty handler map
 * (handlers default to `{}` and every callback is invoked via optional chaining).
 *
 * Verified source (agent-voice-client.ts):
 *   export class AgentVoiceClient {
 *     private handlers: AgentVoiceClientHandlers = {};   // empty by default
 *     private active = false;
 *     private muted = false;
 *     get isActive() { return this.active; }             // false on construct
 *     get isMuted() { return this.muted; }               // false on construct
 *     setMuted(muted) { if (!this.active || ...) return; }      // no-op pre-start
 *     toggleMuted() { this.setMuted(!this.muted); }
 *     setCapturePaused(paused) { if (!this.active || ...) return; } // no-op pre-start
 *     async stop() { ...; this.handlers.onLevel?.(0); this.handlers.onStatus?.("idle"); }
 *   }
 *
 * These tests pin: (a) construction never throws and yields an idle instance,
 * (b) pre-start lifecycle mutators are safe no-ops that do not flip state or
 * break the sequence, and (c) stop() on a freshly-built instance with NO
 * handlers registered does not throw (empty-config resilience).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentVoiceClient · resilient construction under empty/missing configuration", () => {
  it("constructs with zero arguments and never throws", () => {
    expect(() => new AgentVoiceClient()).not.toThrow();
    const client = new AgentVoiceClient();
    expect(client).toBeInstanceOf(AgentVoiceClient);
  });

  it("builds an idle instance: isActive and isMuted are both false on construction", () => {
    const client = new AgentVoiceClient();
    expect(client.isActive).toBe(false);
    expect(client.isMuted).toBe(false);
  });

  it("produces independent instances (no shared singleton state across constructions)", () => {
    const a = new AgentVoiceClient();
    const b = new AgentVoiceClient();
    expect(a).not.toBe(b);
    expect(a.isActive).toBe(b.isActive);
    expect(a.isMuted).toBe(b.isMuted);
  });

  it("treats setMuted as a safe no-op before start() (does not flip muted state)", () => {
    const client = new AgentVoiceClient();
    expect(() => client.setMuted(true)).not.toThrow();
    // Guard `if (!this.active ...) return;` means an inactive client stays unmuted.
    expect(client.isMuted).toBe(false);
    expect(client.isActive).toBe(false);
  });

  it("treats toggleMuted as a safe no-op before start()", () => {
    const client = new AgentVoiceClient();
    expect(() => client.toggleMuted()).not.toThrow();
    expect(client.isMuted).toBe(false);
  });

  it("treats setCapturePaused as a safe no-op before start()", () => {
    const client = new AgentVoiceClient();
    expect(() => client.setCapturePaused(true)).not.toThrow();
    expect(client.isActive).toBe(false);
  });

  it("stop() on a freshly constructed instance with NO handlers registered does not throw", async () => {
    const client = new AgentVoiceClient();
    // handlers default to {}; optional chaining (onLevel?., onStatus?.) keeps
    // this resilient even though nothing was configured.
    await expect(client.stop()).resolves.toBeUndefined();
    expect(client.isActive).toBe(false);
    expect(client.isMuted).toBe(false);
  });

  it("remains stable across a chain of pre-start mutations followed by stop()", async () => {
    const client = new AgentVoiceClient();
    expect(() => {
      client.setMuted(true);
      client.toggleMuted();
      client.setCapturePaused(true);
      client.setCapturePaused(false);
    }).not.toThrow();
    await expect(client.stop()).resolves.toBeUndefined();
    expect(client.isActive).toBe(false);
    expect(client.isMuted).toBe(false);
  });
});

import { ApiService } from "./api-service";
import { AuthService } from "./auth-service";
import { createDirectComputerUseTransport, parseComputerUseSnapshot, readComputerUseJson } from "@/lib/computer-use/direct-transport";
import type { ComputerUseBinding, ComputerUseSnapshot, ComputerUseTransport } from "@/lib/computer-use/contracts";

type Admission = { ownerId: string; podId: string; environment: string };
export type ComputerUseCapability = { available: boolean; code: string };

async function boundedOwnerRequest<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const request = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupted: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      interrupted = () => { request.abort(); reject(new Error("BROWSER_REQUEST_CANCELLED")); };
      signal.addEventListener("abort", interrupted, { once: true });
      timer = setTimeout(() => { request.abort(); reject(new Error("BROWSER_REQUEST_TIMEOUT")); }, 45_000);
      if (signal.aborted) interrupted();
    });
    return await Promise.race([run(request.signal), deadline]);
  } finally {
    clearTimeout(timer);
    if (interrupted) signal.removeEventListener("abort", interrupted);
  }
}

/** Identity and credentials remain with the existing admitted owner-pod transport. */
export class ComputerUseClient {
  private admission: Admission | null = null;
  private available = false;
  private incarnation: string | null = null;

  constructor(private readonly ownerId: string) {}

  private request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const admission = this.admission;
    if (!admission || AuthService.getCurrentUser()?.uid !== this.ownerId || admission.ownerId !== this.ownerId
      || !path.startsWith("/api/one/pod/browser/")) throw new Error("BROWSER_OWNER_UNAVAILABLE");
    const response = await ApiService.ownerPodRequest(path.slice("/api/one/pod/".length), init, false, undefined, admission.podId);
    if (AuthService.getCurrentUser()?.uid !== this.ownerId) throw new Error("BROWSER_OWNER_CHANGED");
    return response;
  };

  async capability(signal: AbortSignal): Promise<ComputerUseCapability> {
    return boundedOwnerRequest(signal, (request) => this.readCapability(request));
  }

  private async readCapability(signal: AbortSignal): Promise<ComputerUseCapability> {
    this.available = false;
    this.incarnation = null;
    const admission = await ApiService.getComputerUseAdmission(signal);
    if (signal.aborted) throw new Error("BROWSER_REQUEST_CANCELLED");
    this.admission = admission;
    if (!admission || !["dev", "development"].includes(admission.environment)) {
      this.admission = null;
      return { available: false, code: "BROWSER_CLOUD_GATE_UNAVAILABLE" };
    }
    const response = await this.request("/api/one/pod/browser/capability", { signal, cache: "no-store" });
    if (!response.ok) throw new Error("BROWSER_CAPABILITY_UNAVAILABLE");
    const body = await readComputerUseJson(response) as { available?: unknown; code?: unknown; owner_id?: unknown; pod_id?: unknown; incarnation?: unknown; environment?: unknown };
    if (signal.aborted) throw new Error("BROWSER_REQUEST_CANCELLED");
    if (body.available === true) {
      if (body.owner_id !== this.ownerId || body.pod_id !== admission.podId || body.environment !== "development"
        || typeof body.incarnation !== "string" || !body.incarnation || body.incarnation.length > 256) {
        throw new Error("BROWSER_CAPABILITY_REFUSED");
      }
      this.incarnation = body.incarnation;
    }
    this.available = body.available === true;
    return { available: this.available, code: typeof body.code === "string" ? body.code : "BROWSER_CLOUD_GATE_UNAVAILABLE" };
  }

  async start(input: { requestId: string; goal: string; allowedOrigins: string[] }, signal: AbortSignal): Promise<ComputerUseSnapshot> {
    return boundedOwnerRequest(signal, (request) => this.startTask(input, request));
  }

  private async startTask(input: { requestId: string; goal: string; allowedOrigins: string[] }, signal: AbortSignal): Promise<ComputerUseSnapshot> {
    if (!this.available || !this.admission || !this.incarnation) throw new Error("BROWSER_CLOUD_GATE_UNAVAILABLE");
    const admission = this.admission;
    const expectedIncarnation = this.incarnation;
    const response = await this.request("/api/one/pod/browser/tasks", {
      method: "POST", signal, headers: { "Content-Type": "application/json", "X-Browser-Pod-Incarnation": expectedIncarnation },
      body: JSON.stringify({ request_id: input.requestId, goal: input.goal, allowed_origins: input.allowedOrigins, fields: [] }),
    });
    if (!response.ok) throw new Error("BROWSER_TASK_UNAVAILABLE");
    const body = await readComputerUseJson(response) as { binding?: { incarnation?: unknown; task_id?: unknown } };
    if (signal.aborted) throw new Error("BROWSER_REQUEST_CANCELLED");
    const incarnation = body.binding?.incarnation;
    const taskId = body.binding?.task_id;
    if (incarnation !== expectedIncarnation || typeof taskId !== "string" || !taskId) {
      throw new Error("BROWSER_TASK_RESPONSE_REFUSED");
    }
    const binding: ComputerUseBinding = { ownerId: this.ownerId, podId: admission.podId, incarnation, taskId, environment: "development" };
    return parseComputerUseSnapshot(body, binding);
  }

  transport(): ComputerUseTransport { return createDirectComputerUseTransport(this.request); }
}

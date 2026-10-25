import { ApiService } from "./api-service";
import { AuthService } from "./auth-service";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
  snapshotValidatedAuthSessionPrincipal,
} from "@/lib/auth/session-owner";
import {
  createDirectComputerUseTransport,
  parseComputerUseSnapshot,
  readComputerUseJson,
} from "@/lib/computer-use/direct-transport";
import type {
  ComputerUseBinding,
  ComputerUsePhase,
  ComputerUseSnapshot,
  ComputerUseTransport,
} from "@/lib/computer-use/contracts";

type Admission = { ownerId: string; podId: string; environment: string };
export type ComputerUseCapability = { available: boolean; code: string };
export type DiscoveredBrowserTask = {
  binding: ComputerUseBinding;
  phase: ComputerUsePhase;
  current: boolean;
};

async function boundedOwnerRequest<T>(
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const request = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupted: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      interrupted = () => {
        request.abort();
        reject(new Error("BROWSER_REQUEST_CANCELLED"));
      };
      signal.addEventListener("abort", interrupted, { once: true });
      timer = setTimeout(() => {
        request.abort();
        reject(new Error("BROWSER_REQUEST_TIMEOUT"));
      }, 45_000);
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

  private readonly receipts = new Map<string, string>();
  private readonly ownerSession = snapshotValidatedAuthSessionOwner();
  private readonly principal = snapshotValidatedAuthSessionPrincipal();

  constructor(
    private readonly ownerId: string,
    private readonly getVaultOwnerToken: () => string | null = () => null,
  ) {}

  private isCurrent = (): boolean => {
    const current = this.ownerSession?.userId === this.ownerId
      && isValidatedAuthSessionOwnerCurrent(this.ownerSession)
      && AuthService.getCurrentUser()?.uid === (this.principal?.firebaseUid ?? this.ownerId);
    if (!current) this.receipts.clear();
    return current;
  };

  private request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const admission = this.admission;
    if (
      !admission ||
      !this.isCurrent() ||
      admission.ownerId !== this.ownerId ||
      !path.startsWith("/api/one/pod/browser/")
    )
      throw new Error("BROWSER_OWNER_UNAVAILABLE");
    const response = await ApiService.ownerPodRequest(
      path.slice("/api/one/pod/".length),
      init,
      false,
      undefined,
      admission.podId,
      this.isCurrent,
    );
    if (!this.isCurrent())
      throw new Error("BROWSER_OWNER_CHANGED");
    return response;
  };

  async capability(signal: AbortSignal): Promise<ComputerUseCapability> {
    return boundedOwnerRequest(signal, (request) =>
      this.readCapability(request),
    );
  }

  async tasks(signal: AbortSignal): Promise<DiscoveredBrowserTask[]> {
    return boundedOwnerRequest(signal, async (request) => {
      await this.readCapability(request);
      if (!this.admission) return [];
      const response = await this.request("/api/one/pod/browser/tasks", {
        signal: request,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("BROWSER_TASK_DISCOVERY_UNAVAILABLE");
      const body = await readComputerUseJson(response);
      if (request.aborted || !Array.isArray(body) || body.length > 20)
        throw new Error("BROWSER_TASK_RESPONSE_REFUSED");
      return body.map((item) => {
        const source = item?.binding;
        const phase = item?.phase as ComputerUsePhase;
        if (
          source?.owner_id !== this.ownerId ||
          source?.pod_id !== this.admission?.podId ||
          source?.environment !== "development" ||
          typeof source.incarnation !== "string" ||
          !source.incarnation ||
          source.incarnation.length > 256 ||
          typeof source.task_id !== "string" ||
          !/^browser_[a-f0-9]{32}$/.test(source.task_id) ||
          ![
            "running",
            "needs_owner",
            "completed",
            "unavailable",
            "outcome_uncertain",
            "cancelled",
          ].includes(phase)
        ) {
          throw new Error("BROWSER_TASK_RESPONSE_REFUSED");
        }
        const current = source.incarnation === this.incarnation;
        if (
          !current &&
          ![
            "completed",
            "cancelled",
            "unavailable",
            "outcome_uncertain",
          ].includes(phase)
        ) {
          throw new Error("BROWSER_TASK_RESPONSE_REFUSED");
        }
        return {
          binding: {
            ownerId: this.ownerId,
            podId: source.pod_id,
            incarnation: source.incarnation,
            taskId: source.task_id,
            environment: "development",
          },
          phase,
          current,
        };
      });
    });
  }

  private async readCapability(
    signal: AbortSignal,
  ): Promise<ComputerUseCapability> {
    if (!this.isCurrent()) throw new Error("BROWSER_OWNER_UNAVAILABLE");
    this.available = false;
    this.incarnation = null;
    const admission = await ApiService.getComputerUseAdmission(signal);
    if (signal.aborted || !this.isCurrent()) throw new Error("BROWSER_REQUEST_CANCELLED");
    this.admission = admission;
    if (!admission || !["dev", "development"].includes(admission.environment)) {
      this.admission = null;
      return { available: false, code: "BROWSER_CLOUD_GATE_UNAVAILABLE" };
    }
    const response = await this.request("/api/one/pod/browser/capability", {
      signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error("BROWSER_CAPABILITY_UNAVAILABLE");
    const body = (await readComputerUseJson(response)) as {
      available?: unknown;
      code?: unknown;
      owner_id?: unknown;
      pod_id?: unknown;
      incarnation?: unknown;
      environment?: unknown;
    };
    if (signal.aborted) throw new Error("BROWSER_REQUEST_CANCELLED");
    if (body.owner_id !== undefined || body.available === true) {
      if (
        body.owner_id !== this.ownerId ||
        body.pod_id !== admission.podId ||
        body.environment !== "development" ||
        typeof body.incarnation !== "string" ||
        !body.incarnation ||
        body.incarnation.length > 256
      ) {
        throw new Error("BROWSER_CAPABILITY_REFUSED");
      }
      this.incarnation = body.incarnation;
    }
    this.available = body.available === true;
    return {
      available: this.available,
      code:
        typeof body.code === "string"
          ? body.code
          : "BROWSER_CLOUD_GATE_UNAVAILABLE",
    };
  }

  async start(
    input: { requestId: string; goal: string; allowedOrigins: string[] },
    signal: AbortSignal,
  ): Promise<ComputerUseSnapshot> {
    return boundedOwnerRequest(signal, (request) =>
      this.startTask(input, request),
    );
  }

  private async startTask(
    input: { requestId: string; goal: string; allowedOrigins: string[] },
    signal: AbortSignal,
  ): Promise<ComputerUseSnapshot> {
    if (!this.available || !this.admission || !this.incarnation)
      throw new Error("BROWSER_CLOUD_GATE_UNAVAILABLE");
    const admission = this.admission;
    const expectedIncarnation = this.incarnation;
    const response = await this.request("/api/one/pod/browser/tasks", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "X-Browser-Pod-Incarnation": expectedIncarnation,
      },
      body: JSON.stringify({
        request_id: input.requestId,
        goal: input.goal,
        allowed_origins: input.allowedOrigins,
        fields: [],
      }),
    });
    if (!response.ok) throw new Error("BROWSER_TASK_UNAVAILABLE");
    const body = (await readComputerUseJson(response)) as {
      binding?: { incarnation?: unknown; task_id?: unknown };
    };
    if (signal.aborted) throw new Error("BROWSER_REQUEST_CANCELLED");
    const incarnation = body.binding?.incarnation;
    const taskId = body.binding?.task_id;
    if (
      incarnation !== expectedIncarnation ||
      typeof taskId !== "string" ||
      !taskId
    ) {
      throw new Error("BROWSER_TASK_RESPONSE_REFUSED");
    }
    const binding: ComputerUseBinding = {
      ownerId: this.ownerId,
      podId: admission.podId,
      incarnation,
      taskId,
      environment: "development",
    };
    return parseComputerUseSnapshot(body, binding);
  }

  transport(): ComputerUseTransport {
    return createDirectComputerUseTransport(this.request, (binding, reviewId, signal) =>
      boundedOwnerRequest(signal, request => this.confirmReview(binding, reviewId, request)),
    );
  }

  private async confirmReview(binding: ComputerUseBinding, reviewId: string, signal: AbortSignal): Promise<string> {
    if (binding.ownerId !== this.ownerId || binding.podId !== this.admission?.podId
      || binding.incarnation !== this.incarnation || !/^dir_[a-f0-9]{32}$/.test(reviewId)) {
      throw new Error("BROWSER_REVIEW_CHANGED");
    }
    const token = this.getVaultOwnerToken();
    if (!token || !this.isCurrent()) throw new Error("BROWSER_OWNER_UNAVAILABLE");
    const response = await this.request(`/api/one/pod/browser/tasks/${encodeURIComponent(binding.taskId)}`, {
      signal, cache: "no-store", headers: { "X-Browser-Pod-Incarnation": binding.incarnation },
    });
    const body = await readComputerUseJson(response) as { review?: { review_id?: unknown; purpose?: unknown; coordination?: unknown } };
    const snapshot = parseComputerUseSnapshot(body, binding);
    if (snapshot.review?.id !== reviewId || body.review?.review_id !== reviewId) throw new Error("BROWSER_REVIEW_CHANGED");
    const review = browserCoordination(body.review.coordination, binding, body.review.purpose);
    // Retain only the receipt in memory so a lost pod response can validate the
    // same consumption. Never send another owner confirmation automatically.
    if (signal.aborted || this.getVaultOwnerToken() !== token || !this.isCurrent()) {
      throw new Error("BROWSER_OWNER_CHANGED");
    }
    const cached = this.receipts.get(reviewId);
    if (cached) return cached;
    if (this.receipts.size >= 256) throw new Error("BROWSER_REVIEW_LIMIT");
    const confirmed = await ApiService.apiFetch("/api/one/pod/browser-approval/confirm", {
      method: "POST", signal, cache: "no-store",
      isEffectCurrent: () => this.isCurrent() && this.getVaultOwnerToken() === token && !signal.aborted,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ review, directive_id: reviewId, confirmed: true }),
    });
    const result = await readComputerUseJson(confirmed) as { status?: unknown; directive_id?: unknown; receipt?: unknown };
    if (signal.aborted || this.getVaultOwnerToken() !== token || !this.isCurrent()
      || result.status !== "confirmed" || result.directive_id !== reviewId
      || typeof result.receipt !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(result.receipt)) {
      throw new Error("BROWSER_CONFIRMATION_UNVERIFIED");
    }
    this.receipts.set(reviewId, result.receipt);
    return result.receipt;
  }
}

/** Project metadata explicitly: a compromised response cannot upload private terms to the hub. */
function browserCoordination(value: unknown, binding: ComputerUseBinding, purpose: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BROWSER_REVIEW_CHANGED");
  const source = value as Record<string, unknown>;
  const selected = source.binding as Record<string, unknown> | undefined;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)
    || selected.owner_id !== binding.ownerId || selected.pod_id !== binding.podId
    || selected.task_id !== binding.taskId || selected.incarnation !== binding.incarnation
    || selected.environment !== "development" || !Number.isSafeInteger(selected.expires_at)
    || (selected.expires_at as number) <= Date.now() / 1000
    || source.purpose !== purpose || !["model_process", "disclose", "session_remember", "session_restore", "provider_safety"].includes(String(purpose))
    || typeof source.commitment !== "string" || !/^[a-f0-9]{64}$/.test(source.commitment)
    || !["dev", "development"].includes(String(source.environment))
    || typeof source.pod_key_id !== "string" || !source.pod_key_id || source.pod_key_id.length > 128
    || typeof source.service_uid !== "string" || !source.service_uid || source.service_uid.length > 256
    || !Number.isSafeInteger(source.epoch) || (source.epoch as number) < 1) {
    throw new Error("BROWSER_REVIEW_CHANGED");
  }
  return {
    binding: { owner_id: binding.ownerId, pod_id: binding.podId, task_id: binding.taskId,
      incarnation: binding.incarnation, environment: "development", expires_at: selected.expires_at },
    purpose, commitment: source.commitment, pod_key_id: source.pod_key_id,
    environment: source.environment, epoch: source.epoch, service_uid: source.service_uid,
  };
}

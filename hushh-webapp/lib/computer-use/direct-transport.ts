import {
  type ComputerUseBinding, type ComputerUsePhase, type ComputerUseReview, type ComputerUseSessionReceipt, type ComputerUseSnapshot,
  type ComputerUseTransport, sameComputerUseBinding,
} from "./contracts";

type AdmittedRequest = (path: string, init: RequestInit) => Promise<Response>;
const ROOT = "/api/one/pod/browser/tasks";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BROWSER_RESPONSE_REFUSED");
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error("BROWSER_RESPONSE_REFUSED");
  }
  return value;
}

function reviewTerms(value: unknown): ComputerUseReview | undefined {
  if (value === undefined || value === null) return undefined;
  const review = record(value);
  const terms = record(review.terms);
  if (typeof review.review_id !== "string" || !review.review_id || review.review_id.length > 128
    || !["model_process", "disclose", "session_remember", "session_restore", "provider_safety"].includes(String(review.purpose))) {
    throw new Error("BROWSER_REVIEW_REFUSED");
  }
  const origins = terms.origins ?? terms.destination_origins ?? [];
  if (!Array.isArray(origins) || origins.length > 20
    || origins.some((origin) => typeof origin !== "string" || !origin || origin.length > 4096)) {
    throw new Error("BROWSER_REVIEW_REFUSED");
  }
  const purpose = review.purpose as ComputerUseReview["purpose"];
  if (purpose === "model_process" && (typeof terms.model !== "string" || !terms.model || terms.model.length > 128
    || typeof terms.task_goal !== "string" || !terms.task_goal || terms.task_goal.length > 4096)) {
    throw new Error("BROWSER_REVIEW_REFUSED");
  }
  const details: ComputerUseReview["details"] = [];
  if (purpose === "disclose" && terms.action !== undefined) {
    const action = record(terms.action);
    if (!["type", "keys"].includes(String(action.operation))) throw new Error("BROWSER_REVIEW_REFUSED");
    if (action.operation === "type") {
      if (typeof action.text !== "string" || action.text.length > 4096) throw new Error("BROWSER_REVIEW_REFUSED");
      details.push({ label: "Enter text", value: action.text });
    } else {
      if (!Array.isArray(action.keys) || action.keys.length > 4
        || action.keys.some((key) => typeof key !== "string" || key.length > 32)) throw new Error("BROWSER_REVIEW_REFUSED");
      details.push({ label: "Keyboard action", value: action.keys.join(" + ") });
    }
  }
  if (purpose === "disclose" && terms.method !== undefined) {
    const actions: Record<string, string> = { POST: "Send information", PUT: "Replace information", PATCH: "Update information", DELETE: "Delete information", GET: "Open this address", HEAD: "Check this address", OPTIONS: "Check website access" };
    if (typeof terms.method !== "string" || !Object.hasOwn(actions, terms.method)) throw new Error("BROWSER_REVIEW_REFUSED");
    const label = actions[terms.method];
    if (label === undefined) throw new Error("BROWSER_REVIEW_REFUSED");
    details.push({ label: "Website action", value: label });
  }
  if (purpose === "model_process" && terms.result_storage !== undefined && terms.result_storage !== "owner_encrypted_log") {
    throw new Error("BROWSER_REVIEW_REFUSED");
  }
  if (purpose === "provider_safety") {
    if (typeof terms.tool !== "string" || !terms.tool || terms.tool.length > 128
      || !Array.isArray(terms.warnings) || !terms.warnings.length || terms.warnings.length > 8) {
      throw new Error("BROWSER_REVIEW_REFUSED");
    }
    const argumentsText = JSON.stringify(record(terms.arguments));
    if (new TextEncoder().encode(argumentsText).length > 65536) throw new Error("BROWSER_REVIEW_REFUSED");
    details.push({ label: "Action", value: terms.tool.replaceAll("_", " ") });
    details.push({ label: "Requested action details", value: argumentsText });
    for (const [index, item] of terms.warnings.entries()) {
      const warning = record(item);
      const message = warning.message ?? warning.code;
      if (typeof message !== "string" || !message || message.length > 4096) {
        throw new Error("BROWSER_REVIEW_REFUSED");
      }
      details.push({ label: `Model warning ${index + 1}`, value: message });
    }
  }
  // Never copy cookies, session state, object references or commitments into view state.
  if (purpose === "model_process" || purpose === "disclose") {
    const fields = terms.fields ?? [];
    const values = record(terms.values ?? {});
    if (!Array.isArray(fields) || fields.length > 16 || Object.keys(values).length !== fields.length) {
      throw new Error("BROWSER_REVIEW_REFUSED");
    }
    const seen = new Set<string>();
    for (const source of fields) {
      const field = record(source);
      if (typeof field.domain !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(field.domain)
        || ["secrets", "runtime_secrets", "wallet", "identity"].includes(field.domain)
        || typeof field.path !== "string" || !/^[a-z0-9_]+(?:\.[a-z0-9_]+){0,7}$/.test(field.path)) {
        throw new Error("BROWSER_REVIEW_REFUSED");
      }
      const scope = `attr.${field.domain}.${field.path}`;
      if (seen.has(scope)) throw new Error("BROWSER_REVIEW_REFUSED");
      seen.add(scope);
      let selected: unknown = record(values[scope])[field.domain];
      for (const segment of field.path.split(".")) selected = record(selected)[segment];
      if (!["string", "boolean", "number"].includes(typeof selected)
        || (typeof selected === "number" && !Number.isFinite(selected))) {
        throw new Error("BROWSER_REVIEW_REFUSED");
      }
      const text = String(selected);
      if (new TextEncoder().encode(JSON.stringify(selected)).length > 4096) throw new Error("BROWSER_REVIEW_REFUSED");
      details.push({ label: `${field.domain} · ${field.path.replaceAll("_", " ")}`, value: text });
    }
  }
  return {
    id: review.review_id, purpose, origins: origins as string[], details,
    model: typeof terms.model === "string" ? terms.model.slice(0, 128) : undefined,
    taskGoal: purpose === "model_process" ? terms.task_goal as string : undefined,
    ...(purpose === "model_process" && terms.result_storage === "owner_encrypted_log" ? { resultStorage: terms.result_storage } : {}),
    destination: typeof terms.destination === "string" ? terms.destination.slice(0, 4096) : undefined,
  };
}

export function parseComputerUseSnapshot(value: unknown, expected: ComputerUseBinding): ComputerUseSnapshot {
  const wire = record(value);
  const source = record(wire.binding);
  for (const name of ["owner_id", "pod_id", "incarnation", "task_id"] as const) {
    if (typeof source[name] !== "string" || !source[name] || source[name].length > 256) {
      throw new Error("BROWSER_RESPONSE_REFUSED");
    }
  }
  const binding: ComputerUseBinding = {
    ownerId: source.owner_id as string, podId: source.pod_id as string,
    incarnation: source.incarnation as string, taskId: source.task_id as string,
    environment: source.environment as "development",
  };
  const phases: ComputerUsePhase[] = ["running", "needs_owner", "completed", "unavailable", "outcome_uncertain", "cancelled"];
  if (!sameComputerUseBinding(binding, expected) || !phases.includes(wire.phase as ComputerUsePhase)
    || !["agent", "owner", "stopped", "uncertain"].includes(String(wire.control_owner))) {
    throw new Error("BROWSER_RESPONSE_REFUSED");
  }
  if (wire.code != null && (typeof wire.code !== "string" || !/^BROWSER_[A-Z0-9_]{1,100}$/.test(wire.code))) {
    throw new Error("BROWSER_RESPONSE_REFUSED");
  }
  if (wire.input_pending !== undefined && typeof wire.input_pending !== "boolean") {
    throw new Error("BROWSER_RESPONSE_REFUSED");
  }
  if (wire.goal_completed !== undefined && typeof wire.goal_completed !== "boolean") throw new Error("BROWSER_RESPONSE_REFUSED");
  const available = record(wire.capability).available;
  if (typeof available !== "boolean") throw new Error("BROWSER_RESPONSE_REFUSED");
  if (wire.summary != null && (typeof wire.summary !== "string" || Array.from(wire.summary).length > 2000)) {
    throw new Error("BROWSER_RESPONSE_REFUSED");
  }
  const origins = wire.approved_origins;
  if (origins !== undefined && (!Array.isArray(origins) || origins.length > 20
    || origins.some((origin) => typeof origin !== "string" || !origin || origin.length > 4096))) {
    throw new Error("BROWSER_RESPONSE_REFUSED");
  }
  const remembered = record(wire.capability).remembered_sessions_available;
  if (remembered !== undefined && typeof remembered !== "boolean") throw new Error("BROWSER_RESPONSE_REFUSED");
  const publicOnly = record(wire.capability).public_research_only;
  if (publicOnly !== undefined && typeof publicOnly !== "boolean") throw new Error("BROWSER_RESPONSE_REFUSED");
  const viewport = wire.viewport == null ? undefined : record(wire.viewport);
  if (viewport && (integer(viewport.width, 320) > 1920 || integer(viewport.height, 240) > 1080)) {
    throw new Error("BROWSER_RESPONSE_REFUSED");
  }
  const downloads = wire.downloads === undefined ? undefined : wire.downloads;
  if (downloads !== undefined && (!Array.isArray(downloads) || downloads.length > 1)) throw new Error("BROWSER_DOWNLOAD_REFUSED");
  const offers = (downloads as unknown[] | undefined)?.map(value => {
    const item = record(value);
    if (typeof item.download_id !== "string" || !/^[a-f0-9]{32}$/.test(item.download_id)
      || typeof item.name !== "string" || !item.name || item.name.length > 255
      || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)
      || integer(item.size, 0) > 4 * 1024 * 1024) throw new Error("BROWSER_DOWNLOAD_REFUSED");
    return { id: item.download_id, name: item.name, size: item.size as number, sha256: item.sha256 };
  });
  return {
    ...(offers ? { downloads: offers } : {}),
    ...(viewport ? { viewport: { width: viewport.width as number, height: viewport.height as number } } : {}),
    binding, phase: wire.phase as ComputerUsePhase,
    ...(typeof wire.code === "string" ? { code: wire.code } : {}),
    ...(wire.input_pending !== undefined ? { inputPending: wire.input_pending as boolean } : {}),
    ...(wire.goal_completed !== undefined ? { goalCompleted: wire.goal_completed as boolean } : {}),
    ...(wire.phase === "completed" && typeof wire.summary === "string" ? { summary: wire.summary } : {}),
    capability: available ? "ready" : "unavailable",
    controlOwner: wire.control_owner as ComputerUseSnapshot["controlOwner"],
    controlEpoch: integer(wire.control_epoch, 1), nextSequence: integer(wire.next_sequence, 1),
    revision: integer(wire.revision, 0),
    review: reviewTerms(wire.review),
    ...(origins !== undefined ? { approvedOrigins: origins as string[] } : {}),
    ...(remembered !== undefined ? { rememberedSessionsAvailable: remembered as boolean } : {}),
    ...(publicOnly !== undefined ? { publicResearchOnly: publicOnly as boolean } : {}),
  };
}

async function boundedBody(response: Response, maximum: number, allowError = false): Promise<Uint8Array> {
  if ((!response.ok && !allowError) || !response.body) throw new Error("BROWSER_RESPONSE_UNAVAILABLE");
  const declared = response.headers.get("Content-Length");
  if (declared && Number(declared) > maximum) throw new Error("BROWSER_RESPONSE_REFUSED");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > maximum) throw new Error("BROWSER_RESPONSE_REFUSED");
      chunks.push(part.value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readComputerUseJson(response: Response, allowError = false): Promise<unknown> {
  const bytes = await boundedBody(response, 64 * 1024, allowError);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 500);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Inject ownerPodRequest after signed endpoint admission; never generic hub fetch. */
export function createDirectComputerUseTransport(
  request: AdmittedRequest,
  confirmReview?: (binding: ComputerUseBinding, reviewId: string, signal: AbortSignal) => Promise<string>,
): ComputerUseTransport {
  const path = (binding: ComputerUseBinding) => `${ROOT}/${encodeURIComponent(binding.taskId)}`;
  const snapshot = async (binding: ComputerUseBinding, suffix: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set("X-Browser-Pod-Incarnation", binding.incarnation);
    const response = await request(`${path(binding)}${suffix}`, { ...init, headers, cache: "no-store" });
    return parseComputerUseSnapshot(await readComputerUseJson(response), binding);
  };
  return {
    saveDownload: async (binding, id, name, parent, signal) => {
      const response = await request(`${path(binding)}/downloads/${encodeURIComponent(id)}`, {
        method: "POST", signal, cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Browser-Pod-Incarnation": binding.incarnation },
        body: JSON.stringify({ name, parent, confirmed: true }),
      });
      const body = record(await readComputerUseJson(response));
      if (body.verified !== true || typeof body.file_id !== "string" || !/^[a-f0-9]{32}$/.test(body.file_id)
        || typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256)
        || integer(body.bytes, 0) > 4 * 1024 * 1024) throw new Error("BROWSER_DOWNLOAD_REFUSED");
      return { fileId: body.file_id, bytes: body.bytes as number, sha256: body.sha256 };
    },
    read: (binding, signal) => snapshot(binding, "", { signal }),
    control: (binding, operation, control_epoch, signal) => snapshot(binding, "/control", {
      method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, control_epoch }),
    }),
    input: (binding, action, signal) => snapshot(binding, "/input", {
      method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(action),
    }),
    review: async (binding, review_id, signal) => {
      if (!confirmReview) throw new Error("BROWSER_OWNER_CONFIRMATION_UNAVAILABLE");
      const receipt = await confirmReview(binding, review_id, signal);
      if (signal.aborted) throw new Error("BROWSER_REQUEST_CANCELLED");
      return snapshot(binding, "/review", {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review_id, receipt }),
      });
    },
    session: async (binding, operation, origin, account_id, signal): Promise<ComputerUseSessionReceipt> => {
      const response = await request(`${path(binding)}/session`, {
        method: "POST", signal, cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Browser-Pod-Incarnation": binding.incarnation },
        body: JSON.stringify({ operation, origin, account_id }),
      });
      const body = record(await readComputerUseJson(response, true));
      if (response.status === 409 && record(body.detail).code === "BROWSER_OWNER_APPROVAL_REQUIRED") {
        return { state: "review_required" };
      }
      if (!response.ok) throw new Error("BROWSER_SESSION_UNAVAILABLE");
      if (operation === "remember" && body.remembered === true && Number.isSafeInteger(body.generation)) {
        return { state: "remembered" };
      }
      if (operation === "restore" && typeof body.restored === "boolean" && body.authenticated === false) {
        return { state: body.restored ? "restored" : "not_found" };
      }
      if (operation === "forget" && [body.fenced, body.persisted, body.deletion_requested].every((flag) => typeof flag === "boolean")
        && body.remote_logout === false && body.physical_deletion === "subject_to_cloud_retention") {
        return { state: "forgotten", fenced: body.fenced as boolean, persisted: body.persisted as boolean,
          deletionRequested: body.deletion_requested as boolean };
      }
      throw new Error("BROWSER_SESSION_RESPONSE_REFUSED");
    },
    watchFrames: async (binding, signal, receive) => {
      let waitingSince: number | undefined;
      while (!signal.aborted) {
        const response = await request(`${path(binding)}/frame`, { signal, cache: "no-store",
          headers: { "X-Browser-Pod-Incarnation": binding.incarnation } });
        if (signal.aborted || response.status === 410) return;
        if (response.status === 409) {
          const body = record(await readComputerUseJson(response, true));
          if (record(body.detail).code === "BROWSER_FRAME_NOT_READY") {
            waitingSince ??= Date.now();
            if (Date.now() - waitingSince > 120_000) throw new Error("BROWSER_FRAME_UNAVAILABLE");
            await delay(signal);
            continue;
          }
        }
        if (response.headers.get("Content-Type")?.split(";")[0] !== "image/png") {
          throw new Error("BROWSER_FRAME_REFUSED");
        }
        if (response.headers.get("X-Browser-Pod-Incarnation") !== binding.incarnation
          || response.headers.get("X-Browser-Task-Id") !== binding.taskId
          || response.headers.get("X-Browser-Pod-Id") !== binding.podId) throw new Error("BROWSER_FRAME_REFUSED");
        // Header presence matters: Number(null) would accidentally admit zero.
        const header = (name: string, minimum: number) => {
          const value = response.headers.get(name);
          if (value === null) throw new Error("BROWSER_FRAME_REFUSED");
          return integer(Number(value), minimum);
        };
        const controlEpoch = header("X-Browser-Control-Epoch", 1);
        const sequence = header("X-Browser-Sequence", 0);
        header("X-Browser-Revision", 0);
        const png = await boundedBody(response, 4 * 1024 * 1024);
        const width = header("X-Browser-Width", 320);
        const height = header("X-Browser-Height", 240);
        if (width > 1920 || height > 1080) throw new Error("BROWSER_FRAME_REFUSED");
        if (!signal.aborted) receive({ binding, controlEpoch, sequence, width, height, png });
        waitingSince = undefined;
        await delay(signal);
      }
    },
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const requestId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const guard = () => {};
beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat"); vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENV", ""); vi.stubEnv("NEXT_PUBLIC_ENVIRONMENT_MODE", ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("@feature_drive_request @trace_loop console diagnostics", () => {
  it.each(["production", "", "unknown"])("suppresses verbose records in %s without changing the operation", async environment => {
    const { traceDriveRequest, observeDriveRequestState } = await import("@/lib/consent/drive-request-diagnostics");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", environment); vi.stubEnv("NEXT_PUBLIC_DEBUG", "true");
    vi.stubGlobal("crypto", { randomUUID: () => documentId, subtle: { digest: async () => new ArrayBuffer(32) } });
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const path = `/api/connectors/google_drive/sharing/requests/${documentId}/allow`;
      await expect(traceDriveRequest(path, "POST", async (_headers, observe) => {
        observe(new Response(null, { status: 200 })); return "allowed";
      }, { oneCopyAccepted: true })).resolves.toBe("allowed");
      observeDriveRequestState(path, { status: "paid" }, guard);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(logs).not.toHaveBeenCalled(); expect(warnings).not.toHaveBeenCalled();
    } finally { logs.mockRestore(); warnings.mockRestore(); }
  });

  it("traces preview/download headers without exposing the file locator or claiming transfer completion", async () => {
    const { traceDriveRequest } = await import("@/lib/consent/drive-request-diagnostics");
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      for (const disposition of ["preview", "download"]) {
        await traceDriveRequest(`/api/connectors/google_drive/sharing/requests/${requestId}/one-copy/files/${documentId}/content?disposition=${disposition}`, "GET", async (_headers, observe) => {
          observe(new Response(null, { status: 200 })); return "headers";
        });
        await vi.waitFor(() => expect(logs).toHaveBeenCalledWith(`[DRIVE_REQUEST][ONE_COPY_${disposition.toUpperCase()}]`, expect.objectContaining({ outcome: "http_returned", http_status: 200 })));
      }
      const serialized = JSON.stringify(logs.mock.calls);
      expect(serialized).not.toContain(documentId); expect(serialized).not.toContain(requestId);
      expect(serialized).not.toContain("stream_completed");
      await traceDriveRequest(`/api/connectors/google_drive/sharing/requests/${requestId}/one-copy/files/${documentId}/content?disposition=download`, "GET", async (_headers, observe) => {
        observe(new Response(null, { status: 200 }));
      });
      await vi.waitFor(() => expect(logs.mock.calls.filter(call => call[0] === "[DRIVE_REQUEST][ONE_COPY_DOWNLOAD]")).toHaveLength(2));
      // A conflicting production label must also deny verbose diagnostics.
      logs.mockClear(); vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENV", "production");
      await traceDriveRequest(`/api/connectors/google_drive/sharing/requests/${requestId}/allow`, "POST", async () => "allowed");
      await new Promise(resolve => setTimeout(resolve, 0)); expect(logs).not.toHaveBeenCalled();
    } finally { logs.mockRestore(); }
  });
  it("projects rejection reasons without private inputs and preserves the refused transaction", async () => {
    const { traceDriveRequest } = await import("@/lib/consent/drive-request-diagnostics");
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = "private-query-email-token-file";
    const failure = Object.assign(new Error("Request refused"), { code: "invalid_argument", status: 422 });
    try {
      await expect(traceDriveRequest(`/api/connectors/google_drive/sharing/requests/${requestId}/allow`, "POST", async (headers, observe) => {
        expect(headers["x-request-id"]).toBeTruthy();
        observe(new Response(null, { status: 422, headers: { "x-hushh-deploy-sha": "a".repeat(40) } }), {
          detail: { code: "invalid_argument", reason: "owner_copy_consent_missing", message: secret },
          purpose: secret, email: secret, files: [{ name: secret }], status: secret,
        });
        throw failure;
      }, { revision: 1, amountCents: 50, token: secret, oneCopyAccepted: false })).rejects.toBe(failure);
      await vi.waitFor(() => expect(warnings).toHaveBeenCalledTimes(1));
      const serialized = JSON.stringify([...logs.mock.calls, ...warnings.mock.calls]);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(requestId);
      expect(serialized).not.toContain("amountCents");
      expect(warnings).toHaveBeenCalledWith("[DRIVE_REQUEST][ALLOW]", expect.objectContaining({
        outcome: "rejected", http_status: 422, reason: "owner_copy_consent_missing", build_sha: "a".repeat(40),
      }));
      expect(warnings.mock.calls[0][1]).not.toHaveProperty("state");
      // Unknown codes and reasons cannot turn a private string into a log field.
      warnings.mockClear();
      await expect(traceDriveRequest(`/api/connectors/google_drive/sharing/requests/${requestId}/allow`, "POST", async (_headers, observe) => {
        observe(new Response(null, { status: 422 }), { detail: { code: secret, reason: secret } });
        throw Object.assign(new Error("Request refused"), { code: secret });
      })).rejects.toThrow();
      await vi.waitFor(() => expect(warnings).toHaveBeenCalledTimes(1));
      expect(JSON.stringify(warnings.mock.calls)).not.toContain(secret);
      // Even a broken console cannot replace the original result or failure.
      logs.mockImplementation(() => { throw new Error("console unavailable"); });
      await expect(traceDriveRequest(`/api/connectors/google_drive/sharing/requests/${requestId}/allow`, "POST", async (_headers, observe) => {
        observe(new Response(null, { status: 202 })); return "saved";
      })).resolves.toBe("saved");
    } finally { logs.mockRestore(); warnings.mockRestore(); }
  });

  it("logs validated state changes without polling spam or claiming evaluation finished", async () => {
    const { traceDriveRequest, observeDriveRequestState } = await import("@/lib/consent/drive-request-diagnostics");
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const path = `/api/connectors/google_drive/searches/${documentId}`;
    try {
      for (const revision of [1, 2, 3]) observeDriveRequestState(path,
        { status: "completed", revision, evaluation: { status: "running" } }, guard);
      const states = () => logs.mock.calls.filter(call => call[0] === "[DRIVE_REQUEST][SEARCH_STATUS]");
      await vi.waitFor(() => expect(states()).toHaveLength(1));
      expect(states()[0][1]).toMatchObject({ state: "completed", evaluation_state: "running", outcome: "observed" });
      observeDriveRequestState(path, { status: "completed", evaluation: { status: "ready" } }, guard);
      await vi.waitFor(() => expect(states()).toHaveLength(2));
      observeDriveRequestState(path, { status: "failed" }, () => { throw Object.assign(new Error("Session changed"), { code: "session_changed" }); });
      // A transport response alone cannot establish a validated lifecycle state.
      await traceDriveRequest(path, "GET", async (_headers, observe) => {
        observe(new Response(null, { status: 200 }), { status: "paid", amountCents: 0 });
      });
      await vi.waitFor(() => expect(states()).toHaveLength(3));
      expect(states()[2][1]).not.toHaveProperty("state");
      observeDriveRequestState(path, { status: "queued", queueDelayed: true }, guard);
      await vi.waitFor(() => expect(states()).toHaveLength(4));
      expect(states()[3][1]).toMatchObject({ state: "queued", queue_delayed: true });
      expect(states()[3][1]).not.toHaveProperty("queued");
    } finally { logs.mockRestore(); }
  });

  it("does not wait for diagnostic hashing before returning or rethrowing", async () => {
    const { traceDriveRequest } = await import("@/lib/consent/drive-request-diagnostics");
    vi.stubGlobal("crypto", { randomUUID: () => documentId, subtle: { digest: () => new Promise(() => {}) } });
    const failure = Object.assign(new Error("Session changed"), { code: "session_changed" });
    try {
      await expect(traceDriveRequest(`/api/connectors/google_drive/sharing/requests/${documentId}/allow`, "POST", async () => "saved")).resolves.toBe("saved");
      await expect(traceDriveRequest(`/api/connectors/google_drive/sharing/requests/${documentId}/allow`, "POST", async () => { throw failure; })).rejects.toBe(failure);
    } finally { vi.unstubAllGlobals(); }
  });

  it("reports copy stage, mismatch and result counts without names or unknown reasons", async () => {
    const { observeDriveRequestState } = await import("@/lib/consent/drive-request-diagnostics");
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const secret = "private-query-email-file-token";
    try {
      const path = `/api/connectors/google_drive/sharing/requests/${requestId}/one-copy`;
      const failed = Array.from({ length: 12 }, () => ({ status: "unavailable", name: secret, reason: "source_changed", copyDiagnostics: { stage: "source_before", mismatches: ["modified_time"] } }));
      observeDriveRequestState(path, { actorRole: "recipient", status: "unavailable", files: failed }, guard);
      await vi.waitFor(() => expect(logs).toHaveBeenCalledWith("[DRIVE_REQUEST][ONE-COPY]", expect.objectContaining({
        copy_unavailable_count: 12, copy_ready_count: 0, copy_reason_source_changed_count: 12,
        copy_failed_stage_source_before_count: 12, copy_mismatch_modified_time_count: 12,
      })));
      observeDriveRequestState(path, { actorRole: "recipient", status: "ready", files: failed.map(file => ({ ...file, status: "ready", reason: secret, copyDiagnostics: { stage: secret, mismatches: [secret] }, sourceMetadataTimeChanged: true })) }, guard);
      await vi.waitFor(() => expect(logs).toHaveBeenCalledWith("[DRIVE_REQUEST][ONE-COPY]", expect.objectContaining({ copy_ready_count: 12, copy_metadata_time_changed_count: 12 })));
      expect(JSON.stringify(logs.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(logs.mock.calls)).not.toContain(requestId);
      observeDriveRequestState(`/api/connectors/google_drive/searches/${documentId}`, { status: "completed", matched: 25, unshareableCount: 13, coverage: { providerRowsScanned: 25, providerFilePages: 8, dateBasis: "provider_query", datePushdown: "not_expressed", query: secret } }, guard);
      await vi.waitFor(() => expect(logs).toHaveBeenCalledWith("[DRIVE_REQUEST][SEARCH_STATUS]", expect.objectContaining({ retained_count: 25, unshareable_count: 13, provider_rows: 25, provider_file_pages: 8, date_basis: "provider_query", date_pushdown: "not_expressed" })));
      expect(JSON.stringify(logs.mock.calls)).not.toContain(secret);
    } finally { logs.mockRestore(); }
  });
});

it("@feature_drive_request @trace_loop separates native rows, retained files, date exclusions and fallback", async () => {
  const { observeDriveRequestState } = await import("@/lib/consent/drive-request-diagnostics");
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    observeDriveRequestState(`/api/connectors/google_drive/searches/${documentId}`, {
      status: "queued", matched: 5001, nextRetryAt: "2026-09-27T00:05:00Z", retryReason: "provider_unavailable",
      diagnostics: { queries: [{ query: "private-frozen-query" }], fallbackDecision: { privateKey: "private-decision" } },
      coverage: { dateBasis: "activity_union", datePolicy: "drive_activity_union_v1", dateGateApplied: true,
        fallbackActivated: true, providerRowsScanned: 25001, providerFilePages: 251, excludedByDateCount: 20000,
        query: "private-query", name: "private-name" },
    }, guard);
    await vi.waitFor(() => expect(logs).toHaveBeenCalled());
    expect(logs.mock.calls[0][1]).toMatchObject({ retained_count: 5001, provider_rows: 25001, provider_file_pages: 251,
      excluded_by_date_count: 20000, date_policy: "drive_activity_union_v1", date_gate_applied: true, fallback_activated: true,
      retry_reason: "provider_unavailable", next_retry_at: "2026-09-27T00:05:00.000Z" });
    expect(JSON.stringify(logs.mock.calls)).not.toContain("private-");
  } finally { logs.mockRestore(); }
});


it.each([
  ["uat", "uat", true], ["development", "development", true],
  ["production", "production", false], ["uat", "production", false],
  ["unknown", "", false], ["__proto__", "", false], ["", "", false],
])("@trace_loop allows verbose logs only for verified deployment %s/%s", async (app, telemetry, enabled) => {
  const { traceDriveRequest, observeDriveRequestState } = await import("@/lib/consent/drive-request-diagnostics");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", app);
  vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENV", telemetry);
  vi.stubEnv("NEXT_PUBLIC_ENVIRONMENT_MODE", "");
  vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_DEBUG", "true");
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(traceDriveRequest(`/api/connectors/google_drive/sharing/requests/${documentId}/allow`, "POST", async (headers, observe) => {
      expect(headers["x-request-id"]).toBeTruthy();
      observe(Response.json({ status: "queued" }, { status: 202 }), { status: "queued", purpose: "private-input" });
      return "accepted";
    })).resolves.toBe("accepted");
    observeDriveRequestState(`/api/connectors/google_drive/sharing/requests/${documentId}/allow`, { status: "queued", purpose: "private-input" }, guard);
    const failure = Object.assign(new Error("private-provider-text"), { code: "provider_unavailable" });
    await expect(traceDriveRequest(`/api/connectors/google_drive/sharing/requests/${documentId}/allow`, "POST", async () => { throw failure; })).rejects.toBe(failure);
    if (enabled) await vi.waitFor(() => expect(warnings).toHaveBeenCalled());
    if (enabled) await vi.waitFor(() => expect(logs).toHaveBeenCalled());
    else { await new Promise(resolve => setTimeout(resolve, 20)); expect(logs).not.toHaveBeenCalled(); expect(warnings).not.toHaveBeenCalled(); }
    expect(JSON.stringify(logs.mock.calls)).not.toContain("private-input");
  } finally { logs.mockRestore(); warnings.mockRestore(); vi.unstubAllEnvs(); }
});

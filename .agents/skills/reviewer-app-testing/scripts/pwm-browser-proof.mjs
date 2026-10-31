/** Injected into the reviewer's page. All decrypted exports stay in this closure. */
export function installPwmBrowserProof({ expectedUserId, expectedEmails }) {
  const nativeFetch = window.fetch.bind(window);
  const streams = [];
  let report = null, usage = null, preferences = null, ownerHeaders = null;
  let lastResearchState = null;
  const identity = { lookup_seen: false, http_ok: false, parse_ok: false,
    uid_match: false, email_verified: false, expected_email_match: false };
  let decisionTime = null, researchPosts = 0;
  let generation = 0, watching = false, freshAcknowledged = false, previousDraft = null, preservation = null;
  let responseFence = 0;
  let latestObservedDraft = null;
  let identityGeneration = 0;
  let baseline = null, expectation = null, exportCode = "idle", armed = null;
  let baselineClaimed = false;
  const current = () => {
    const bridge = window.__HUSHH_NATIVE_TEST__;
    return bridge?.enabled === true && bridge.expectedUserId === expectedUserId &&
      bridge.bootstrapUserId === expectedUserId && bridge.bootstrapState === "vault_unlocked";
  };
  const equal = (a, b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  };
  const result = (value, observedGeneration, observedFence) => {
    if (observedGeneration !== generation || observedFence !== responseFence) return;
    const statuses = ["pending", "paused", "offered", "saved", "unavailable", "consent_required", "insufficient_identity", "not_ready", "disabled"];
    if (!statuses.includes(value?.status)) return;
    lastResearchState = { status: value.status, restart_required: value.restart_required === true,
      exhausted: value.research_exhausted === true,
      retry_after_s: Number.isFinite(value.retry_after_s) && value.retry_after_s >= 0 ? value.retry_after_s : null };
    if (value.status === "offered") latestObservedDraft = value.draft_id;
    if (!["pending", "paused"].includes(value.status)) {
      report = freshAcknowledged && value.status === "offered" && value.draft_id !== previousDraft ? value : null;
      usage = null;
    }
  };
  async function observeStream(response, observedGeneration, observedFence) {
    if (!watching || observedGeneration !== generation) return;
    const receipt = { status: response.status, reads: 0, events: [], startedAt: performance.now(), error: false };
    streams.push(receipt);
    const reader = response.body?.getReader();
    if (!reader) { receipt.error = true; return; }
    const decoder = new TextDecoder();
    let tail = "", bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (observedGeneration !== generation) return;
        if (chunk.done) break;
        receipt.reads++;
        bytes += chunk.value.byteLength;
        if (bytes > 10 * 1024 * 1024) throw new Error("bounded stream");
        tail += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        let end;
        while ((end = tail.indexOf("\n\n")) >= 0) {
          const frame = tail.slice(0, end); tail = tail.slice(end + 2);
          const event = /^event:\s*(\S+)/m.exec(frame)?.[1];
          if (!["progress", "partial", "result", "ping"].includes(event)) continue;
          receipt.events.push({ event, read: receipt.reads, ms: Math.round(performance.now() - receipt.startedAt) });
          if (event === "result") {
            result(JSON.parse(frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")), observedGeneration, observedFence);
          }
        }
      }
    } catch { receipt.error = true; }
    finally { await reader.cancel().catch(() => undefined); }
  }
  const observingFetch = async (...args) => {
    const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
    const method = args[1]?.method ?? (args[0] instanceof Request ? args[0].method : "GET");
    if (url.origin === location.origin && url.pathname.startsWith("/api/one/world-model/")) {
      const headers = new Headers(args[1]?.headers ?? (args[0] instanceof Request ? args[0].headers : undefined));
      if (headers.has("Authorization")) ownerHeaders = headers;
      if (watching && method === "POST" && ["/api/one/world-model/jobs", "/api/one/world-model/ensure"].includes(url.pathname)) {
        const newResearch = researchPosts === 0 || url.pathname.endsWith("/jobs");
        researchPosts++;
        responseFence++; lastResearchState = null; report = null; usage = null;
        // Ensure resumes this research; it must not erase its paid-start or
        // transport receipts. Only a new explicit refresh starts another epoch.
        if (newResearch) {
          previousDraft = latestObservedDraft;
          generation++;
          streams.length = 0; freshAcknowledged = false;
        }
      }
    }
    const observedGeneration = generation;
    const observedFence = responseFence;
    const identityLookup = url.hostname === "identitytoolkit.googleapis.com" && url.pathname.endsWith("/accounts:lookup");
    const observedIdentityGeneration = identityLookup ? ++identityGeneration : identityGeneration;
    if (identityLookup) Object.assign(identity, { lookup_seen: true, http_ok: false, parse_ok: false,
      uid_match: false, email_verified: false, expected_email_match: false });
    const response = await nativeFetch(...args);
    if (identityLookup && observedIdentityGeneration === identityGeneration) {
      Object.assign(identity, { lookup_seen: true, http_ok: response.ok, parse_ok: false,
        uid_match: false, email_verified: false, expected_email_match: false });
      void response.clone().json().then(value => {
        if (observedIdentityGeneration !== identityGeneration) return;
        const user = value.users?.find(user => user.localId === expectedUserId);
        Object.assign(identity, { parse_ok: true, uid_match: Boolean(user),
          email_verified: user?.emailVerified === true,
          expected_email_match: expectedEmails.includes(String(user?.email).toLowerCase()) });
      }).catch(() => undefined);
    }
    if (url.origin !== location.origin) return response;
    if (url.pathname === "/api/one/world-model/jobs/stream" && response.ok) {
      void observeStream(response.clone(), observedGeneration, observedFence);
    } else if (["/api/one/world-model/jobs", "/api/one/world-model/ensure", "/api/one/world-model/preferences"].includes(url.pathname)) {
      void response.clone().json().then(value => {
        if (observedGeneration !== generation || observedFence !== responseFence) return;
        if (watching && method === "POST" && response.ok && ["pending", "paused"].includes(value?.status)) freshAcknowledged = true;
        result(value, observedGeneration, observedFence);
        if (url.pathname.endsWith("/preferences") && response.ok) preferences = value;
      }).catch(() => undefined);
    }
    return response;
  };
  window.fetch = observingFetch;

  // Intercept the app's existing Download Memory action, never its API/key path.
  // Only the armed export's Blob is retained, and no download reaches disk.
  const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
  const anchorClick = HTMLAnchorElement.prototype.click;
  const blobs = new Map();
  const canonical = value => value && typeof value === "object"
    ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
  async function commitment(data, salt) {
    const bytes = new TextEncoder().encode(`${salt}\n${JSON.stringify(canonical(data))}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  URL.createObjectURL = blob => { const url = createUrl(blob); if (armed) blobs.set(url, blob); return url; };
  URL.revokeObjectURL = url => { blobs.delete(url); revokeUrl(url); };
  function expectedMarkdown(before, text, topic) {
    if (typeof before !== "string" || !before.startsWith("# memory.md\n") || before.includes("```") || before.includes("~~~")) return null;
    const preferenceTopics = ["preferences", "dislikes", "style", "food", "shopping", "entertainment", "travel", "interests", "communication"];
    const heading = preferenceTopics.includes(topic) ? "## Preferences" : "## Facts";
    const lines = before.trimEnd().split("\n"), start = lines.indexOf(heading);
    if (start < 0 || lines.includes(`- ${text}`)) return null;
    let end = start + 1;
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
    while (end > start + 1 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, "", `- ${text}`, "");
    return `${lines.join("\n").trimEnd()}\n`;
  }
  async function consumeExport(blob, mode) {
    try {
      const value = JSON.parse(await blob.text());
      const data = value.readable?.one_memory;
      if (!current() || value.meta?.user_id !== expectedUserId || value.meta?.export_version !== 1 ||
          !data || typeof data !== "object" || Array.isArray(data)) { exportCode = "refused"; return; }
      if (mode === "baseline") {
        baseline = structuredClone(data); exportCode = "baseline_ready"; return;
      }
      const claim = data._pwm_claims?.[expectation.key];
      if (!claim || claim.key !== expectation.key || claim.text !== expectation.statement ||
          claim.topic !== expectation.topic || claim.decision !== "accepted" || claim.basis !== "owner_declaration" ||
          !Number.isFinite(Date.parse(claim.decided_at)) || !data.markdown?.split("\n").includes(`- ${expectation.statement}`)) {
        exportCode = "mismatch"; return;
      }
      if (mode === "cold") {
        const proof = expectation.preservation;
        exportCode = proof && claim.decided_at === expectation.decided_at &&
          await commitment(data, proof.salt) === proof.digest && current() ? "cold_verified" : "mismatch";
        return;
      }
      if (!baseline || baseline._pwm_claims?.[expectation.key] ||
          Date.parse(claim.decided_at) < expectation.startedAt || !Number.isFinite(Date.parse(data.updated_at))) {
        exportCode = "refused"; return;
      }
      const markdown = expectedMarkdown(baseline.markdown, expectation.statement, expectation.topic);
      if (!markdown) { exportCode = "refused"; return; }
      const expected = { ...baseline, markdown, updated_at: data.updated_at,
        _pwm_claims: { ...(baseline._pwm_claims ?? {}), [expectation.key]: {
          key: expectation.key, text: expectation.statement, topic: expectation.topic,
          decision: "accepted", basis: "owner_declaration", decided_at: claim.decided_at,
        } }, _deleted_fact_labels: baseline._deleted_fact_labels ?? [] };
      if (!equal(expected, data)) { exportCode = "mismatch"; return; }
      const salt = [...crypto.getRandomValues(new Uint8Array(32))].join(",");
      const digest = await commitment(data, salt);
      if (!current()) { exportCode = "refused"; return; }
      preservation = { salt, digest }; decisionTime = claim.decided_at;
      exportCode = "preserved";
    } catch { exportCode = "unavailable"; }
    finally { if (mode !== "baseline") baseline = null; }
  }
  HTMLAnchorElement.prototype.click = function () {
    if (armed && /^hushh-memory-\d{4}-\d{2}-\d{2}\.json$/.test(this.download)) {
      const blob = blobs.get(this.href), mode = armed; armed = null; blobs.clear();
      if (!blob) { exportCode = "unavailable"; return; }
      void consumeExport(blob, mode); return;
    }
    return anchorClick.call(this);
  };
  window.__PWM_ACCEPTANCE__ = {
    identityMatches: () => current() && window.fetch === observingFetch && Object.values(identity).every(Boolean),
    // Closed diagnostics distinguish account mismatch from missing observation.
    // Identity values and the authentication response never leave this closure.
    identityProof: () => ({ ...identity, current_bridge: current(), observer_installed: window.fetch === observingFetch }),
    publicResult: () => report,
    preferences: () => preferences,
    usage: () => usage,
    researchPosts: () => researchPosts,
    researchState: () => ({ ...lastResearchState, research_posts: researchPosts, fresh_acknowledged: freshAcknowledged }),
    researchSettled: () => researchPosts > 0 && Boolean(lastResearchState) &&
      !["pending", "paused"].includes(lastResearchState.status),
    decisionTime: () => decisionTime,
    // An opaque salted commitment crosses contexts in process memory only;
    // neither it nor any private content belongs in evidence artifacts.
    preservationCommitment: () => current() ? preservation : null,
    beginResearch() {
      if (!current() || watching) return false;
      previousDraft = latestObservedDraft;
      generation++; responseFence++; watching = true; freshAcknowledged = false;
      report = null; usage = null; lastResearchState = null; streams.length = 0; return true;
    },
    async refreshUsage() {
      usage = null;
      if (!current() || !ownerHeaders || !report?.draft_id) return false;
      const draftId = report.draft_id, observedGeneration = generation, observedFence = responseFence;
      const response = await nativeFetch(`/api/one/world-model/jobs?draft_id=${encodeURIComponent(draftId)}`, { headers: ownerHeaders, cache: "no-store" });
      if (!current() || !response.ok || report?.draft_id !== draftId || observedGeneration !== generation || observedFence !== responseFence) return false;
      const header = response.headers.get("X-Hussh-PWM-Usage");
      if (header) usage = JSON.parse(header);
      return Boolean(header);
    },
    streamProof: () => streams.map(({ status, reads, events, error }) => ({ status, reads, events, error })),
    armExport(mode, input = null) {
      if (!current() || !["baseline", "after", "cold"].includes(mode) || armed ||
          (mode === "baseline" && baselineClaimed) || (mode === "after" && !baseline)) return false;
      if (mode === "baseline") baselineClaimed = true;
      if (input) expectation = { ...input, startedAt: Date.now() };
      if (mode !== "baseline" && !expectation) return false;
      exportCode = "pending"; armed = mode; return true;
    },
    exportStatus: () => exportCode,
    async bindClaim(statement, topic) {
      if (!current() || !baseline || expectation) return null;
      const normalized = statement.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!。]+$/u, "");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pwm-claim-v1\n${normalized}`));
      const key = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (!current() || baseline._pwm_claims?.[key] || !expectedMarkdown(baseline.markdown, statement, topic)) return null;
      expectation = { key, statement, topic, startedAt: Date.now() };
      return key;
    },
  };
}

/** Pings and one buffered final chunk do not prove incremental transport. */
export function hasIncrementalPwmStream(streams) {
  return streams.some(stream => stream.status === 200 && !stream.error && stream.reads > 1 &&
    stream.events.some(early => ["progress", "partial"].includes(early.event) &&
      stream.events.some(later => later.event === "result" && later.read > early.read && later.ms > early.ms)));
}

/** Explicit human profile ownership admits review, never promotes model identity. */
export function admitOwnerConfirmedPwmClaim(offered, fact, confirmedProfile) {
  function profile(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port ||
          !/^\/[a-zA-Z0-9-]{1,39}\/?$/.test(url.pathname)) return null;
      return url.pathname.replace(/\/$/, "").toLowerCase();
    } catch { return null; }
  }
  const confirmed = profile(confirmedProfile), identity = offered?.research?.identity;
  const candidate = offered?.research?.candidates?.find(value => value.id === identity?.selected_candidate_id);
  return Boolean(confirmed && offered?.status === "offered" &&
    ["matched", "uncertain"].includes(offered.report?.match_status) &&
    ["owner_linked", "candidate_for_review"].includes(identity?.state) &&
    candidate?.anchor_ids?.length > 0 && candidate.blocking_conflicts?.length === 0 &&
    fact?.confidence === "supported" && fact.sources?.length > 0 &&
    fact.sources.every(source => profile(source.url) === confirmed));
}

export function admitPwmStore(body, { owner, baselineRevision, planId }) {
  const plan = body?.mutation_plan, receipt = plan?.confirmation_receipt;
  return body?.user_id === owner && body.domain === "one_memory" &&
    body.expected_data_version === baselineRevision && plan?.version === 2 &&
    plan.proposed_domain === "one_memory" && plan.writer_id === "pwm_owner_review" &&
    typeof plan.plan_id === "string" && (!planId || plan.plan_id === planId) &&
    receipt?.plan_id === plan.plan_id && receipt.confirmed_by_user_id === owner &&
    receipt.surface === "web" && receipt.authorization_mode === "owner_confirmed" &&
    receipt.displayed_domain === "one_memory";
}

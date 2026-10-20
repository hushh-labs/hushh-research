import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { installPwmBrowserProof, hasIncrementalPwmStream, admitOwnerConfirmedPwmClaim, admitPwmStore } from "../scripts/pwm-browser-proof.mjs";

test("human confirmation admits only the exact received profile without promoting model identity", () => {
  const offered = { status: "offered", report: { match_status: "uncertain" }, research: {
    identity: { state: "candidate_for_review", selected_candidate_id: "c1" },
    candidates: [{ id: "c1", anchor_ids: ["a1"], blocking_conflicts: [] }],
  } };
  const fact = { confidence: "supported", sources: [{ url: "https://github.com/owner" }] };
  const unchanged = JSON.stringify(offered);
  assert.equal(admitOwnerConfirmedPwmClaim(offered, fact, "https://github.com/owner/"), true);
  assert.equal(JSON.stringify(offered), unchanged);
  for (const source of ["https://github.com/namesake", "https://github.com/owner/repository", "https://github.com/owner-extra", "https://linkedin.com/in/owner", "https://github.com@evil.example/owner"])
    assert.equal(admitOwnerConfirmedPwmClaim(offered, { ...fact, sources: [{ url: source }] }, "https://github.com/owner"), false, source);
  for (const state of ["ambiguous", "no_match"])
    assert.equal(admitOwnerConfirmedPwmClaim({ ...offered, research: { ...offered.research, identity: { ...offered.research.identity, state } } }, fact, "https://github.com/owner"), false);
  const conflict = structuredClone(offered); conflict.research.candidates[0].blocking_conflicts.push("Conflicting affiliation");
  assert.equal(admitOwnerConfirmedPwmClaim(conflict, fact, "https://github.com/owner"), false);
  assert.equal(admitOwnerConfirmedPwmClaim(offered, fact, ""), false);
  assert.equal(admitOwnerConfirmedPwmClaim(offered, { ...fact, confidence: "uncertain" }, "https://github.com/owner"), false);
  assert.equal(admitOwnerConfirmedPwmClaim(offered, { ...fact, sources: [...fact.sources, { url: "https://linkedin.com/in/owner" }] }, "https://github.com/owner"), false);
  assert.equal(admitOwnerConfirmedPwmClaim(offered, { ...fact, sources: [] }, "https://github.com/owner"), false);
});

function fixture(fetch = async () => new Response("{}"), browserCrypto = webcrypto) {
  class PageURL extends URL {}
  const blobs = new Map(); let nextUrl = 0;
  PageURL.createObjectURL = blob => { const url = `blob:${++nextUrl}`; blobs.set(url, blob); return url; };
  PageURL.revokeObjectURL = url => blobs.delete(url);
  class Anchor { click() { throw new Error("Private export must never download"); } }
  const bridge = { enabled: true, expectedUserId: "owner", bootstrapUserId: "owner", bootstrapState: "vault_unlocked" };
  const window = { fetch, __HUSHH_NATIVE_TEST__: bridge };
  vm.runInNewContext(`(${installPwmBrowserProof.toString()})(config)`, {
    window, config: { expectedUserId: "owner", expectedEmails: ["owner@example.com"] },
    URL: PageURL, HTMLAnchorElement: Anchor, location: { href: "https://uat.one.hussh.ai/one", origin: "https://uat.one.hussh.ai" },
    Request, Headers, TextDecoder, TextEncoder, structuredClone, crypto: browserCrypto, performance,
  });
  const proof = window.__PWM_ACCEPTANCE__;
  async function exportData(mode, data, input = null, owner = "owner") {
    assert.equal(proof.armExport(mode, input), true);
    const url = PageURL.createObjectURL(new Blob([JSON.stringify({ meta: { user_id: owner, export_version: 1 }, readable: { one_memory: data } })]));
    const anchor = new Anchor(); anchor.href = url; anchor.download = "hushh-memory-2026-10-20.json";
    anchor.click(); PageURL.revokeObjectURL(url);
    for (let i = 0; i < 100 && proof.exportStatus() === "pending"; i++) await new Promise(resolve => setTimeout(resolve, 1));
    return proof.exportStatus();
  }
  return { proof, bridge, exportData, window };
}
const before = { schema_version: "one.memory.md.v1", markdown: "# memory.md\n\n## Facts\n\n- Existing private fact\n\n## Preferences\n\n## Commitments\n",
  updated_at: "2026-10-19T00:00:00.000Z", _deleted_fact_labels: [], private_branch: { retained: [1, 2] } };

test("preservation success is unavailable until its commitment completes", async () => {
  let block = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { proof, exportData } = fixture(undefined, {
    getRandomValues: array => webcrypto.getRandomValues(array),
    subtle: { digest: async (...args) => { if (block) await gate; return webcrypto.subtle.digest(...args); } },
  });
  await exportData("baseline", before);
  const key = await proof.bindClaim("Public statement.", "career"), time = new Date().toISOString();
  const after = { ...before, updated_at: time,
    markdown: "# memory.md\n\n## Facts\n\n- Existing private fact\n\n- Public statement.\n\n\n## Preferences\n\n## Commitments\n",
    _pwm_claims: { [key]: { key, text: "Public statement.", topic: "career", decision: "accepted", basis: "owner_declaration", decided_at: time } } };
  block = true;
  const pending = exportData("after", after);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(proof.exportStatus(), "pending"); assert.equal(proof.preservationCommitment(), null);
  release(); assert.equal(await pending, "preserved"); assert.ok(proof.preservationCommitment());
});

test("browser-only export proves exactly one atomic PWM addition and refuses sibling loss", async () => {
  for (const mutation of ["none", "private-branch", "extra-bullet", "wrong-topic", "missing-claim", "extra-claim-field"]) {
    const { proof, exportData } = fixture();
    assert.equal(await exportData("baseline", before), "baseline_ready");
    const key = await proof.bindClaim("Public statement.", "career");
    assert.equal(typeof key, "string");
    const time = new Date().toISOString();
    const claim = { key, text: "Public statement.", topic: "career", decision: "accepted", basis: "owner_declaration", decided_at: time };
    const after = { ...structuredClone(before), updated_at: time,
      markdown: before.markdown.replace("- Existing private fact", "- Existing private fact\n\n- Public statement.\n"), _pwm_claims: { [key]: claim } };
    // The authored insertion adds one blank line before the next section.
    after.markdown = "# memory.md\n\n## Facts\n\n- Existing private fact\n\n- Public statement.\n\n\n## Preferences\n\n## Commitments\n";
    if (mutation === "private-branch") after.private_branch.retained.pop();
    if (mutation === "extra-bullet") after.markdown += "- Unapproved\n";
    if (mutation === "wrong-topic") claim.topic = "education";
    if (mutation === "missing-claim") delete after._pwm_claims[key];
    if (mutation === "extra-claim-field") claim.extra = true;
    assert.equal(await exportData("after", after), mutation === "none" ? "preserved" : "mismatch", mutation);
    if (mutation === "none") {
      const preservation = proof.preservationCommitment();
      for (const coldMutation of ["none", "lost-sibling", "extra-addition"]) {
        const fresh = fixture(), coldData = structuredClone(after);
        if (coldMutation === "lost-sibling") delete coldData.private_branch;
        if (coldMutation === "extra-addition") coldData.extra = true;
        assert.equal(await fresh.exportData("cold", coldData, { key, statement: "Public statement.", topic: "career", decided_at: time, preservation }),
          coldMutation === "none" ? "cold_verified" : "mismatch", coldMutation);
      }
    }
    assert.equal(proof.armExport("baseline"), false);
    assert.equal(proof.armExport("after"), false);
    assert.equal("baseline" in proof, false);
  }
});

test("wrong export owner, changed vault and stale cold decision refuse without plaintext output", async () => {
  const wrong = fixture();
  assert.equal(await wrong.exportData("baseline", before, null, "another-owner"), "refused");
  const locked = fixture(); locked.bridge.bootstrapState = "authenticated";
  assert.equal(locked.proof.armExport("baseline"), false);
  const cold = fixture(), key = "k", time = new Date().toISOString();
  assert.equal(await cold.exportData("cold", { ...before, markdown: `${before.markdown}- Public statement.\n`, _pwm_claims: {
    [key]: { key, text: "Public statement.", topic: "career", decision: "accepted", basis: "owner_declaration", decided_at: time },
  } }, { key, statement: "Public statement.", topic: "career", decided_at: "2026-01-01T00:00:00Z" }), "mismatch");
});

test("actual reader distinguishes chunked progress from a buffered final response", async () => {
  for (const chunked of [false, true]) {
    const progress = 'event: progress\ndata: {}\n\n', result = 'event: result\ndata: {"status":"offered"}\n\n';
    const { window, proof } = fixture(async url => String(url).endsWith("/ensure") ? new Response('{"status":"pending"}') : new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunked ? progress : progress + result));
        if (!chunked) controller.close();
        else setTimeout(() => { controller.enqueue(new TextEncoder().encode(result)); controller.close(); }, 10);
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    assert.equal(proof.beginResearch(), true);
    await window.fetch("/api/one/world-model/ensure", { method: "POST" });
    await window.fetch("/api/one/world-model/jobs/stream");
    for (let i = 0; i < 100 && !proof.streamProof()[0]?.events.some(item => item.event === "result"); i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(hasIncrementalPwmStream(proof.streamProof()), chunked);
  }
});

test("late old jobs response cannot replace the new draft or its bound usage", async () => {
  let finishOld, count = 0, usageUrl = "";
  const usage = { model_calls: 2, recorded_calls: 2 };
  const { window, proof } = fixture(async (url, options) => {
    if (String(url).includes("draft_id=")) { usageUrl = String(url); return new Response("{}", { headers: { "X-Hussh-PWM-Usage": JSON.stringify(usage) } }); }
    if (options?.method === "POST") return new Response('{"status":"pending"}');
    if (++count === 1) return new Promise(resolve => { finishOld = resolve; });
    return new Response('{"status":"offered","draft_id":"new"}');
  });
  const old = window.fetch("/api/one/world-model/jobs");
  proof.beginResearch();
  await window.fetch("/api/one/world-model/jobs", { method: "POST", headers: { Authorization: "Bearer memory-only-test-token" } });
  await new Promise(resolve => setTimeout(resolve, 1));
  finishOld(new Response('{"status":"offered","draft_id":"old"}')); await old;
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(proof.publicResult(), null);
  await window.fetch("/api/one/world-model/jobs");
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(proof.publicResult().draft_id, "new");
  assert.equal(await proof.refreshUsage(), true);
  assert.equal(usageUrl, "/api/one/world-model/jobs?draft_id=new");
  assert.equal(proof.usage().model_calls, 2);
});

test("store admission binds owner, one_memory, revision, writer, plan and confirmation", () => {
  const context = { owner: "owner", baselineRevision: 60, planId: "plan" };
  const body = { user_id: "owner", domain: "one_memory", expected_data_version: 60, mutation_plan: {
    version: 2, plan_id: "plan", proposed_domain: "one_memory", writer_id: "pwm_owner_review", confirmation_receipt: {
      plan_id: "plan", confirmed_by_user_id: "owner", surface: "web", authorization_mode: "owner_confirmed", displayed_domain: "one_memory",
    },
  } };
  assert.equal(admitPwmStore(body, context), true);
  for (const mutate of [value => { value.user_id = "other"; }, value => { value.domain = "professional"; },
    value => { value.expected_data_version = 59; }, value => { value.mutation_plan.writer_id = "other"; },
    value => { value.mutation_plan.confirmation_receipt.confirmed_by_user_id = "other"; },
    value => { value.mutation_plan.confirmation_receipt.plan_id = "other"; }]) {
    const candidate = structuredClone(body); mutate(candidate); assert.equal(admitPwmStore(candidate, context), false);
  }
});

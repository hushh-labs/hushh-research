/**
 * The owner's direct line to their pod, from the app's side.
 *
 * What these pin: the app key is generated once and never exported; the pinned
 * endpoint refuses a version regression and a re-keying without a bump; the
 * challenge is signed in the byte-exact shape the pod verifies (DER ECDSA over the
 * payload the pod returned); a revocation the pod cannot receive becomes an
 * owner-signed intent couriered through the hub and reported as PENDING, never as
 * done.
 */
import "fake-indexeddb/auto";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as ownerPod from "@/lib/services/owner-pod-endpoint";

const USER = "uid-owner";
const POD_URL = "https://one-pod-owner-abc.a.run.app";

type Call = { target: "hub" | "direct"; url: string; init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function endpointBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "pod_endpoint_v1",
    hushhId: "ha1_owner",
    url: POD_URL,
    podKeyId: "podk_1",
    environment: "dev",
    endpointVersion: 1,
    signature: "ed25519.kid.sig",
    ...overrides,
  };
}

class FakeWorld {
  calls: Call[] = [];
  endpoint = endpointBody();
  bindingIssued = false;
  podReachable = true;
  challengePayload = '{"challenge_id":"psc_1","epoch":3,"hushh_id":"ha1_owner","nonce":"n","pod_key_id":"podk_1","purpose":"pod-session-admission","subject_id":"tdv_app_1"}';
  admitted: Array<Record<string, unknown>> = [];
  couriered: Array<Record<string, unknown>> = [];
  revokes: Array<Record<string, unknown>> = [];
  now = 1_757_500_000_000;

  transport(): ownerPod.OwnerPodTransport {
    return {
      hub: async (path, init) => this.hub(path, init),
      direct: async (url, init) => this.direct(url, init),
      now: () => this.now,
    };
  }

  async hub(path: string, init: RequestInit): Promise<Response> {
    this.calls.push({ target: "hub", url: path, init });
    if (path === "/api/account/trusted-devices/self-enroll") {
      return json({ device_id: "tdv_app_1", platform: "web", status: "active" });
    }
    if (path === "/api/one/personal-agent/endpoint") return json(this.endpoint);
    if (path.endsWith("/pod-binding") && init.method === "GET") {
      return this.bindingIssued
        ? json({ binding: { subject_id: "tdv_app_1", pod_key_id: "podk_1" }, signature: "ed25519.kid.b", version: 1 })
        : json({ detail: { code: "POD_BINDING_NOT_ISSUED" } }, 404);
    }
    if (path.endsWith("/pod-binding") && init.method === "POST") {
      this.bindingIssued = true;
      return json({ binding: { subject_id: "tdv_app_1", pod_key_id: "podk_1" }, signature: "ed25519.kid.b", version: 1 });
    }
    if (path.endsWith("/pod-tombstone")) {
      this.couriered.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({ queued: true });
    }
    return json({ detail: "unexpected" }, 500);
  }

  async direct(url: string, init: RequestInit): Promise<Response> {
    this.calls.push({ target: "direct", url, init });
    if (!this.podReachable) throw new TypeError("Failed to fetch");
    if (url === `${POD_URL}/api/one/pod/session/challenge`) {
      return json({ challengeId: "psc_1", nonce: "n", epoch: 3, podKeyId: "podk_1", signingPayload: this.challengePayload });
    }
    if (url === `${POD_URL}/api/one/pod/session/admit`) {
      this.admitted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({ session: "pst1.eyJzaWQiOiJwc3NfMSJ9.bWFj", sid: "pss_1", role: "app", scopes: ["pkm.read"], epoch: 3, expiresAt: this.now + 12 * 3600 * 1000, version: 1 });
    }
    if (url === `${POD_URL}/api/one/pod/session/revoke`) {
      this.revokes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({ revoked: true, subjectId: "tdv_mac_1", atVersion: 1 });
    }
    return json({ detail: "not found" }, 404);
  }
}

function verifyDer(publicKeySpkiB64: string, payload: string, signatureB64: string): boolean {
  const key = createPublicKey({ key: Buffer.from(publicKeySpkiB64, "base64"), format: "der", type: "spki" });
  return nodeVerify("sha256", Buffer.from(payload, "utf8"), { key, dsaEncoding: "der" }, Buffer.from(signatureB64, "base64"));
}

describe("owner pod endpoint", () => {
  let world: FakeWorld;

  beforeEach(async () => {
    world = new FakeWorld();
    await ownerPod.forgetOwnerPodState(USER);
  });

  afterEach(async () => {
    await ownerPod.forgetOwnerPodState(USER);
  });

  it("enrols the app once with a non-extractable key and reuses the subject", async () => {
    const first = await ownerPod.ensureAppEnrollment(USER, world.transport());
    const second = await ownerPod.ensureAppEnrollment(USER, world.transport());
    expect(first).toBe("tdv_app_1");
    expect(second).toBe("tdv_app_1");
    const enrolments = world.calls.filter((c) => c.url.endsWith("/self-enroll"));
    expect(enrolments).toHaveLength(1);
    const body = JSON.parse(String(enrolments[0].init.body)) as Record<string, unknown>;
    expect(body.platform).toBe("web");
    expect(String(body.devicePublicKey)).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("pins the endpoint and refuses a regression or a re-key without a bump", async () => {
    const pinned = await ownerPod.refreshEndpointFromHub(USER, world.transport());
    expect(pinned.url).toBe(POD_URL);
    expect(pinned.endpointVersion).toBe(1);
    expect(await ownerPod.loadPinnedEndpoint(USER)).toMatchObject({ podKeyId: "podk_1" });

    world.endpoint = endpointBody({ podKeyId: "podk_rotated" });
    await expect(ownerPod.refreshEndpointFromHub(USER, world.transport())).rejects.toMatchObject({
      code: "ENDPOINT_CHANGED_WITHOUT_VERSION_BUMP",
    });

    world.endpoint = endpointBody({ podKeyId: "podk_rotated", endpointVersion: 2 });
    const moved = await ownerPod.refreshEndpointFromHub(USER, world.transport());
    expect(moved.endpointVersion).toBe(2);

    world.endpoint = endpointBody({ endpointVersion: 1 });
    await expect(ownerPod.refreshEndpointFromHub(USER, world.transport())).rejects.toMatchObject({
      code: "ENDPOINT_VERSION_REGRESSION",
    });
    expect((await ownerPod.loadPinnedEndpoint(USER))?.podKeyId).toBe("podk_rotated");
  });

  it("refuses a malformed endpoint record", async () => {
    world.endpoint = endpointBody({ url: "http://plain.example" });
    await expect(ownerPod.refreshEndpointFromHub(USER, world.transport())).rejects.toMatchObject({
      code: "ENDPOINT_MALFORMED",
    });
    expect(await ownerPod.loadPinnedEndpoint(USER)).toBeNull();
  });

  it("opens a session by proving possession of the app key in the pod's byte-exact shape", async () => {
    await ownerPod.refreshEndpointFromHub(USER, world.transport());
    const session = await ownerPod.openPodSession(USER, world.transport());

    expect(session.session.startsWith("pst1.")).toBe(true);
    expect(session.role).toBe("app");
    const admit = world.admitted[0];
    expect(admit.challengeId).toBe("psc_1");
    expect(admit.epoch).toBe(3);
    expect(admit.binding).toMatchObject({ subject_id: "tdv_app_1" });
    // The proof verifies with node's DER ECDSA over EXACTLY the payload the pod sent.
    const enrol = world.calls.find((c) => c.url.endsWith("/self-enroll"));
    const publicKey = String((JSON.parse(String(enrol!.init.body)) as { devicePublicKey: string }).devicePublicKey);
    expect(verifyDer(publicKey, world.challengePayload, String(admit.proof))).toBe(true);
    expect(verifyDer(publicKey, world.challengePayload + " ", String(admit.proof))).toBe(false);
    // The binding was issued (404 then POST), not invented.
    expect(world.calls.filter((c) => c.url.endsWith("/pod-binding")).map((c) => c.init.method)).toEqual(["GET", "POST"]);
  });

  it("refuses to dial a pod the binding does not name", async () => {
    await ownerPod.refreshEndpointFromHub(USER, world.transport());
    world.endpoint = endpointBody({ podKeyId: "podk_other", endpointVersion: 2 });
    await ownerPod.refreshEndpointFromHub(USER, world.transport());
    await expect(ownerPod.openPodSession(USER, world.transport())).rejects.toMatchObject({
      code: "BINDING_POD_KEY_MISMATCH",
    });
    expect(world.calls.some((c) => c.target === "direct")).toBe(false);
  });

  it("reuses a live session and renews one that is close to expiry", async () => {
    await ownerPod.refreshEndpointFromHub(USER, world.transport());
    const opened = await ownerPod.openPodSession(USER, world.transport());
    const reused = await ownerPod.currentPodSession(USER, world.transport());
    expect(reused.sid).toBe(opened.sid);
    world.now = opened.expiresAt - 30 * 60 * 1000;
    world.direct = async function (this: FakeWorld, url: string, init: RequestInit) {
      this.calls.push({ target: "direct", url, init });
      expect(url).toBe(`${POD_URL}/api/one/pod/session/renew`);
      expect(String((init.headers as Record<string, string>).Authorization)).toBe(`Bearer ${opened.session}`);
      return json({ session: "pst1.eyJzaWQiOiJwc3NfMiJ9.bWFj", sid: "pss_2", role: "app", scopes: ["pkm.read"], epoch: 3, expiresAt: this.now + 12 * 3600 * 1000, version: 1 });
    }.bind(world);
    const renewed = await ownerPod.currentPodSession(USER, world.transport());
    expect(renewed.sid).toBe("pss_2");
  });

  it("revokes at the pod first and reports delivered", async () => {
    await ownerPod.refreshEndpointFromHub(USER, world.transport());
    await ownerPod.openPodSession(USER, world.transport());
    const result = await ownerPod.revokeAtPod(USER, "tdv_mac_1", world.transport());
    expect(result).toEqual({ delivered: true, pending: null });
    expect(world.revokes[0]).toMatchObject({ subjectId: "tdv_mac_1", reason: "owner_revoked" });
    expect(world.couriered).toEqual([]);
    expect(await ownerPod.pendingRevocations(USER)).toEqual([]);
  });

  it("couriers an owner-signed intent when the pod is unreachable and reports pending", async () => {
    await ownerPod.refreshEndpointFromHub(USER, world.transport());
    await ownerPod.openPodSession(USER, world.transport());
    world.podReachable = false;

    const result = await ownerPod.revokeAtPod(USER, "tdv_mac_1", world.transport(), { atVersion: 2 });

    expect(result.delivered).toBe(false);
    expect(result.pending).toMatchObject({ subjectId: "tdv_mac_1", atVersion: 2, couriered: true });
    const couriered = world.couriered[0] as { intent: Record<string, unknown>; signature: string };
    expect(couriered.intent).toMatchObject({
      kind: "pod_tombstone_intent_v1",
      hushhId: "ha1_owner",
      subjectId: "tdv_mac_1",
      atVersion: 2,
      signerSubjectId: "tdv_app_1",
    });
    expect(Object.keys(couriered.intent).sort()).toEqual(
      ["atVersion", "hushhId", "intentId", "issuedAtMs", "kind", "signerSubjectId", "subjectId"],
    );
    const enrol = world.calls.find((c) => c.url.endsWith("/self-enroll"));
    const publicKey = String((JSON.parse(String(enrol!.init.body)) as { devicePublicKey: string }).devicePublicKey);
    expect(verifyDer(publicKey, ownerPod.canonicalJson(couriered.intent), couriered.signature)).toBe(true);
    const pending = await ownerPod.pendingRevocations(USER);
    expect(pending).toHaveLength(1);
    await ownerPod.clearPendingRevocation(USER, pending[0].intentId);
    expect(await ownerPod.pendingRevocations(USER)).toEqual([]);
  });

  it("canonical JSON matches the pod's byte layout", () => {
    expect(
      ownerPod.canonicalJson({ zeta: 1, alpha: "a", nested: { b: [1, 2], a: "x" } }),
    ).toBe('{"alpha":"a","nested":{"a":"x","b":[1,2]},"zeta":1}');
  });

  it("converts a raw P1363 signature to DER with minimal integers", () => {
    const r = new Uint8Array(32).fill(0x01);
    const s = new Uint8Array(32);
    s[0] = 0x80;
    const der = ownerPod.p1363ToDer(new Uint8Array([...r, ...s]));
    expect(der[0]).toBe(0x30);
    expect(der[2]).toBe(0x02);
    expect(der[3]).toBe(32); // r has no leading zero and no high bit: 32 bytes
    expect(der[4 + 32]).toBe(0x02);
    expect(der[5 + 32]).toBe(33); // s has the high bit set: padded with 0x00
    expect(der[6 + 32]).toBe(0x00);
  });
});

/** Synthetic signed hub and direct-pod transport for admission boundary tests. */
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import * as ownerPod from "@/lib/services/owner-pod-endpoint";

const issuer = generateKeyPairSync("ed25519");
const publicRaw = issuer.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
function hubSignature(payload: Record<string, unknown>): string {
  return `ed25519.kid.${nodeSign(null, Buffer.from(ownerPod.canonicalJson(payload)), issuer.privateKey).toString("base64url")}`;
}

export const USER = "uid-owner";
export const POD_URL = "https://one-pod-owner-abc.a.run.app";

type Call = { target: "hub" | "direct"; url: string; init: RequestInit };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function endpointBody(overrides: Record<string, unknown> = {}) {
  const body = {
    kind: "pod_endpoint_v1",
    hushhId: "ha1_owner",
    url: POD_URL,
    podKeyId: "podk_1",
    environment: "dev",
    endpointVersion: 1,
    ...overrides,
  };
  return { ...body, signature: hubSignature(body) };
}

export class FakeWorld {
  calls: Call[] = [];
  endpoint = endpointBody();
  bindingIssued = false;
  bindingVersion = 0;
  appPublicKey = "";
  podReachable = true;
  challengePayload = '{"challenge_id":"psc_1","epoch":3,"hushh_id":"ha1_owner","nonce":"n","pod_key_id":"podk_1","purpose":"pod-session-admission","subject_id":"tdv_app_1"}';
  admitted: Array<Record<string, unknown>> = [];
  couriered: Array<Record<string, unknown>> = [];
  revokes: Array<Record<string, unknown>> = [];
  now = 1_757_500_000_000;
  bindingIssuedOffsetMs = -1000;
  bindingExpiresOffsetMs = 24 * 3600 * 1000;
  deploymentTarget = "user_gcp";

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
      this.appPublicKey = String((JSON.parse(String(init.body)) as { devicePublicKey: string }).devicePublicKey);
      return json({ device_id: "tdv_app_1", platform: "web", status: "active" });
    }
    if (path === "/api/one/personal-agent/verification-keys") return json({ kind: "pod_verification_keys_v1", keys: { kid: publicRaw } });
    if (path === "/api/one/personal-agent/endpoint") return json(this.endpoint);
    const binding = {
      kind: "pod_binding_v1", hushh_id: "ha1_owner", user_id: USER,
      environment: "dev", url: POD_URL, pod_key_id: "podk_1",
      subject_id: "tdv_app_1", subject_kind: "app", subject_public_key: this.appPublicKey,
      platform: "web", role: "app", scopes: ["pkm.read"], deployment_target: this.deploymentTarget,
      version: this.bindingVersion || 1, issued_at_ms: this.now + this.bindingIssuedOffsetMs, expires_at_ms: this.now + this.bindingExpiresOffsetMs,
    };
    if (path.endsWith("/pod-binding") && init.method === "GET") {
      return this.bindingIssued
        ? json({ binding, signature: hubSignature(binding), version: 1 })
        : json({ detail: { code: "POD_BINDING_NOT_ISSUED" } }, 404);
    }
    if (path.endsWith("/pod-binding") && init.method === "POST") {
      this.bindingIssued = true;
      this.bindingVersion += 1;
      binding.version = this.bindingVersion;
      return json({ binding, signature: hubSignature(binding), version: binding.version });
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
      return json({ challengeId: "psc_1", nonce: "n", epoch: 3, podKeyId: "podk_1", expiresAt: this.now + 60_000, signingPayload: this.challengePayload });
    }
    if (url === `${POD_URL}/api/one/pod/session/admit`) {
      this.admitted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({ session: "pst1.eyJzaWQiOiJwc3NfMSJ9.bWFj", sid: "pss_1", role: "app", scopes: ["pkm.read"], epoch: 3, expiresAt: this.now + 12 * 3600 * 1000, version: this.bindingVersion || 1 });
    }
    if (url === `${POD_URL}/api/one/pod/session/revoke`) {
      this.revokes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({ revoked: true, subjectId: "tdv_mac_1", atVersion: 1 });
    }
    return json({ detail: "not found" }, 404);
  }
}


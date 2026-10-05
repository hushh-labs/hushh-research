/**
 * Resolve the agent's sealing key from the hub-signed pod binding, then seal.
 *
 * The binding (`pod_binding_v1`) is the record the app already trusts for
 * owner-direct admission: Ed25519-signed by the hub and verified here with the
 * same `verifyHubSignature` admission uses. It must name exactly the pod this
 * request is addressed to (owner, HusshID, pod key id, url, environment and
 * this app's subject), so a re-pointed or re-keyed pod is refused rather than
 * handed the person's provider key. Read-only: a GET never issues a grant.
 */
import { readJson, verifyHubSignature } from "@/lib/services/owner-pod-crypto";
import type { OwnerPodTransport, PinnedEndpoint, PodSessionRecord } from "@/lib/services/owner-pod-endpoint";
import { normalizeAiSelection, sealAiSelection, type AiSelectionRecipient } from "./ai-selection-seal";

export type AiSelectionSealContext = {
  userId: string;
  endpoint: PinnedEndpoint;
  session: PodSessionRecord;
  transport: OwnerPodTransport;
};

export async function agentRecipientFromBinding({
  userId,
  endpoint,
  session,
  transport,
}: AiSelectionSealContext): Promise<AiSelectionRecipient> {
  const response = await transport.hub(
    `/api/account/trusted-devices/${encodeURIComponent(session.subjectId)}/pod-binding`,
    { method: "GET", cache: "no-store" },
  );
  if (!response.ok) throw new Error("AGENT_KEY_UNAVAILABLE");
  const body = await readJson(response);
  const binding = body.binding as Record<string, unknown> | undefined;
  const signature = String(body.signature ?? "");
  if (!binding || typeof binding !== "object" || !signature) throw new Error("AGENT_KEY_UNAVAILABLE");
  await verifyHubSignature(binding, signature, transport);
  const now = (transport.now ?? Date.now)();
  if (
    binding.kind !== "pod_binding_v1" ||
    binding.user_id !== userId ||
    binding.hushh_id !== endpoint.hushhId ||
    binding.pod_key_id !== endpoint.podKeyId ||
    binding.url !== endpoint.url ||
    binding.environment !== endpoint.environment ||
    binding.subject_id !== session.subjectId ||
    typeof binding.pod_public_key !== "string" ||
    !binding.pod_public_key ||
    !Number.isInteger(binding.expires_at_ms) ||
    Number(binding.expires_at_ms) <= now
  ) {
    throw new Error("AGENT_KEY_MISMATCH");
  }
  return { hushhId: endpoint.hushhId, podKeyId: endpoint.podKeyId, publicKey: binding.pod_public_key };
}

/** Replace a plaintext selection body with its sealed envelope for this pod. */
export async function sealAiSelectionRequestBody(body: string, context: AiSelectionSealContext): Promise<string> {
  const selection = normalizeAiSelection(JSON.parse(body) as unknown);
  const recipient = await agentRecipientFromBinding(context);
  return JSON.stringify(await sealAiSelection(selection, recipient, (context.transport.now ?? Date.now)()));
}

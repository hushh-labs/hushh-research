"use client";

import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { appendMarkdownMemoryFacts, markdownMemoryToAgentContext, peekMarkdownMemory, MAX_MARKDOWN_MEMORY_CHARS } from "@/lib/pkm/markdown-memory";
import { assertNoUnguardedSecrets } from "@/lib/pkm/secret-span-guard";
import { pkmPlanIdForIdempotencyScope, type PkmUserConfirmation } from "@/lib/personal-knowledge-model/mutation-plan";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import type { SoulSection } from "@/lib/pkm/soul-document";

export const EMAIL_MEMORY_TAG_SECTIONS = {
  finance: "Facts", contacts: "Facts", projects: "Facts", facts: "Facts",
  preferences: "Preferences", commitments: "Commitments",
} as const satisfies Record<string, SoulSection>;

export type EmailMemorySaveDirective = {
  kind: "email_memory_save";
  owner_id: string;
  request_id: string;
  domain_tag: keyof typeof EMAIL_MEMORY_TAG_SECTIONS;
  fact_markdown: string;
  section: SoulSection;
  digest: string;
};
export type EmailMemoryCommitReceipt = {
  status: "committed"; saved: true; saved_count: number; revision: number;
  receipt_ref: string; request_id: string; digest: string;
};
export type EmailMemorySaveOutcome = EmailMemoryCommitReceipt |
  { status: "unavailable" | "pending_client_commit"; saved: false; code: string };
export type EmailMemoryProjection = {
  source: "one_memory.markdown"; owner_id: string; markdown: string;
  budget_chars: number; revision: number | null;
};

/** Closed ingress schema: local presentation flags never become authority. */
export function emailMemoryCommitPayload(receipt: EmailMemoryCommitReceipt) {
  return { request_id: receipt.request_id, digest: receipt.digest, receipt_ref: receipt.receipt_ref,
    revision: receipt.revision, saved_count: receipt.saved_count };
}

/** RAM only: a missing projection does not trigger a hidden vault/network read. */
export function projectEmailMemoryMdFromRam(ownerId: string, isCurrent: () => boolean): EmailMemoryProjection | null {
  const owner = snapshotValidatedAuthSessionOwner();
  if (!owner || owner.userId !== ownerId || !isCurrent()) return null;
  const memory = peekMarkdownMemory(ownerId);
  if (!memory) return null;
  const markdown = markdownMemoryToAgentContext(memory).text;
  if (markdown.length > MAX_MARKDOWN_MEMORY_CHARS || !isValidatedAuthSessionOwnerCurrent(owner) || !isCurrent()) return null;
  return { source: "one_memory.markdown" as const, owner_id: ownerId, markdown,
    budget_chars: MAX_MARKDOWN_MEMORY_CHARS, revision: memory.dataVersion ?? null };
}

export function parseEmailMemorySaveDirective(value: unknown): EmailMemorySaveDirective | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== "email_memory_save" || typeof v.owner_id !== "string" || !v.owner_id || v.owner_id.length > 128 ||
      typeof v.request_id !== "string" || !/^[0-9a-f-]{36}$/i.test(v.request_id) ||
      typeof v.domain_tag !== "string" || !Object.hasOwn(EMAIL_MEMORY_TAG_SECTIONS, v.domain_tag) ||
      typeof v.fact_markdown !== "string" || !v.fact_markdown.trim() || v.fact_markdown.length > 2048 ||
      typeof v.digest !== "string" || !/^[0-9a-f]{64}$/.test(v.digest) ||
      v.section !== EMAIL_MEMORY_TAG_SECTIONS[v.domain_tag as keyof typeof EMAIL_MEMORY_TAG_SECTIONS]) return null;
  return v as EmailMemorySaveDirective;
}

export async function emailMemorySaveDigest(directive: Omit<EmailMemorySaveDirective, "digest">): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([directive.kind, directive.owner_id, directive.request_id,
    directive.domain_tag, directive.fact_markdown, directive.section]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}

/** Explicit review -> existing encrypted/revision-safe writer -> real ledger ack. */
export async function commitEmailMemorySave(input: {
  directive: EmailMemorySaveDirective; userId: string; vaultKey: string; vaultOwnerToken: string;
  confirmation: PkmUserConfirmation; isCurrent: () => boolean;
}): Promise<EmailMemorySaveOutcome> {
  const directive = parseEmailMemorySaveDirective(input.directive);
  const owner = snapshotValidatedAuthSessionOwner();
  const epoch = snapshotVaultSessionEpoch();
  const current = () => Boolean(owner && owner.userId === input.userId && directive?.owner_id === input.userId &&
    input.vaultKey && input.vaultOwnerToken && isValidatedAuthSessionOwnerCurrent(owner) &&
    isVaultSessionEpochCurrent(epoch) && input.isCurrent());
  const unavailable = (code: string): EmailMemorySaveOutcome => ({ status: "unavailable", saved: false, code });
  if (!directive || !current() || input.confirmation.confirmedByUser !== true ||
      "authorizationMode" in input.confirmation) return unavailable("memory_authority_changed");
  if (await emailMemorySaveDigest(directive) !== directive.digest) return unavailable("memory_directive_invalid");
  const scope = `email-memory:${directive.request_id}:${directive.digest}`;
  const planId = pkmPlanIdForIdempotencyScope(scope);
  const assertCurrent = async () => { if (!current()) throw new Error("Memory authority changed."); };
  let writeAttempted = false;
  try {
    assertNoUnguardedSecrets([directive.fact_markdown]);
    await assertCurrent();
    writeAttempted = true;
    const result = await appendMarkdownMemoryFacts({ userId: input.userId, vaultKey: input.vaultKey,
      vaultOwnerToken: input.vaultOwnerToken,
      facts: [{ section: directive.section, text: `[${directive.domain_tag}] ${directive.fact_markdown}` }],
      confirmation: input.confirmation, idempotencyScope: scope, beforeEffect: assertCurrent });
    await assertCurrent();
    // A successful local staging result is not a committed PKM revision.
    const [receipt] = await PersonalKnowledgeModelService.lookupMutationCommits({ userId: input.userId,
      vaultOwnerToken: input.vaultOwnerToken, commits: [{ domain: "one_memory", planId }] });
    await assertCurrent();
    if (!receipt?.exists || !Number.isSafeInteger(receipt.dataVersion) || receipt.dataVersion! < 0) {
      return { status: "pending_client_commit", saved: false, code: "memory_commit_unconfirmed" };
    }
    return { status: "committed", saved: true, saved_count: result.success ? result.saved : 0,
      revision: receipt.dataVersion!, receipt_ref: planId, request_id: directive.request_id, digest: directive.digest };
  } catch {
    if (current() && writeAttempted) return { status: "pending_client_commit", saved: false, code: "memory_commit_unconfirmed" };
    return unavailable(current() ? "memory_commit_failed" : "memory_authority_changed");
  }
}

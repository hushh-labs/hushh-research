"use client";

import { z } from "zod";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { SecureResourceCacheService } from "./secure-resource-cache-service";
import { ApiService } from "./api-service";
import { DurableResourceError } from "./durable-resource-error";
import type { PrivateReceiptMailbox } from "./gmail-receipts-service";
import { decryptExport, encryptForExport } from "@/lib/vault/export-encrypt";
import { receiptStoreGuard, type ReceiptStoreSession } from "@/lib/mail/receipt-store";

type MailStateKind = "tracking" | "topics";
const version = z.object({ revision: z.number().int().positive() });
const envelope = version.extend({
  sealed: z.object({ ciphertext: z.string(), iv: z.string(), tag: z.string() }),
});

function additionalData(owner: string, mailbox: PrivateReceiptMailbox, kind: MailStateKind, revision: number): string {
  return JSON.stringify(["mail_private_state.v1", owner, mailbox.accountId, mailbox.credentialId, kind, revision]);
}

async function request(
  session: ReceiptStoreSession,
  mailbox: PrivateReceiptMailbox,
  kind: MailStateKind,
  operation: "read" | "write",
  body: object,
) {
  const current = receiptStoreGuard(session);
  if (!current()) throw new DurableResourceError("authority_changed", "authority", "Mail session changed.");
  const response = await ApiService.ownerPodRequest(
    `connectors/gmail/accounts/${mailbox.accountId}/state/${kind}/${operation}`,
    {
      method: "POST", cache: "no-store", signal: session.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, credential_id: mailbox.credentialId }),
    },
    false, undefined, undefined, current,
  );
  if (response.status === 409) {
    const code = (await response.json().catch(() => null))?.detail?.code;
    if (code === "MAIL_STATE_CONFLICT") throw new DurableResourceError("stale_version", "commit", "Mail information changed. Try again.");
  }
  if (!response.ok) throw new Error("The private agent could not open this Mail information.");
  const result: unknown = await response.json();
  if (!current()) throw new DurableResourceError("authority_changed", "authority", "Mail session changed.");
  return result;
}

function cacheScope(session: ReceiptStoreSession, mailbox: PrivateReceiptMailbox, kind: MailStateKind) {
  const resourceKey = JSON.stringify(["mail-state-cache.v1", snapshotVaultSessionEpoch(), mailbox.accountId, mailbox.credentialId, kind]);
  return { userId: session.userId, vaultKey: session.vaultKey, resourceKey };
}

async function openRecord(session: ReceiptStoreSession, mailbox: PrivateReceiptMailbox, kind: MailStateKind, raw: unknown, current: () => boolean) {
  const record = envelope.parse(raw);
  const plaintext = await decryptExport(record.sealed.ciphertext, record.sealed.iv, record.sealed.tag, session.vaultKey, {
    additionalData: additionalData(session.userId, mailbox, kind, record.revision),
  });
  if (!current()) throw new DurableResourceError("authority_changed", "authority", "Mail session changed.");
  return { revision: record.revision, value: JSON.parse(plaintext) as unknown };
}

export const PrivateMailStateService = {
  async readCached(session: ReceiptStoreSession, mailbox: PrivateReceiptMailbox, kind: MailStateKind) {
    const current = receiptStoreGuard(session);
    if (!current()) return null;
    const raw = await SecureResourceCacheService.read(cacheScope(session, mailbox, kind));
    if (!raw || !current()) return null;
    return openRecord(session, mailbox, kind, raw, current);
  },

  async read(session: ReceiptStoreSession, mailbox: PrivateReceiptMailbox, kind: MailStateKind) {
    const current = receiptStoreGuard(session);
    const scope = cacheScope(session, mailbox, kind);
    const raw = await request(session, mailbox, kind, "read", {});
    if (raw === null) {
      await SecureResourceCacheService.invalidateResource(scope.userId, scope.resourceKey);
      return null;
    }
    const opened = await openRecord(session, mailbox, kind, raw, current);
    void SecureResourceCacheService.write({ ...scope, value: raw, ttlMs: 86400000 });
    return opened;
  },

  async write(session: ReceiptStoreSession, mailbox: PrivateReceiptMailbox, kind: MailStateKind, value: unknown, expected: number) {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).length > 256 * 1024)
      throw new Error("Mail information is too large to save.");
    const sealed = await encryptForExport(serialized, session.vaultKey, {
      additionalData: additionalData(session.userId, mailbox, kind, expected + 1),
    });
    const result = version.parse(await request(session, mailbox, kind, "write", { expected_revision: expected, sealed }));
    if (result.revision !== expected + 1) throw new Error("Mail storage returned a different revision.");
    return result.revision;
  },
};

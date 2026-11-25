/**
 * Keeps a Mail reply bound to the exact original email it was opened from.
 *
 * A reply reference (`rs1.`) is deliberately short-lived, and a person can take
 * longer than that to write. This module renews it from the stable, owner- and
 * account-bound source id (`ms1.`) the Overview opened, so the reply stays on
 * the same message and the text the person has written is never part of the
 * renewal. It holds no mail content, only ids and the recipient and subject the
 * server derived.
 *
 * Renewal never changes where a reply goes. If the original now yields a
 * different recipient or subject than the one the person reviewed, the new
 * envelope is held and shown only when they review again.
 */

import {
  MailOverviewError,
  prepareMailReply,
  type MailReplySource,
} from "@/lib/mail/mail-overview-client";

/** Renew this long before the reference expires. */
export const REPLY_RENEW_LEAD_MS = 2 * 60_000;

const SOURCE_ID = /^ms1\.[A-Za-z0-9_-]{16,2044}$/;
const MAX_BINDINGS = 20;

export type MailReplyEnvelope = { sourceMailRef: string; to: string; subject: string };

type Issued = MailReplyEnvelope & { issuedAtMs: number; ttlMs: number };

type Binding = {
  ownerId: string;
  sourceId: string;
  expectedAccount: string | null;
  current: Issued;
  /** A renewal whose recipient or subject differs from the reviewed one. */
  held: Issued | null;
  inflight: Promise<Issued> | null;
};

export type MailReplyRenewal = {
  /** The envelope to use from now on. Unchanged unless `adopted`. */
  envelope: MailReplyEnvelope;
  /** The original now derives a different recipient or subject than the one reviewed. */
  changed: boolean;
  adopted: boolean;
};

export type MailReplyBindingInput = {
  ownerId: string;
  sourceId: string;
  expectedAccount: string | null;
  reply: Pick<MailReplySource, "sourceMailRef" | "to" | "subject" | "expiresInSeconds">;
  issuedAtMs: number;
};

type RenewContext = {
  ownerId: string;
  vaultOwnerToken: string;
  /** Adopt a changed recipient or subject. Only after the person has been told. */
  adoptChanged?: boolean;
  signal?: AbortSignal;
};

export function isMailSourceId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_ID.test(value);
}

function issued(
  reply: Pick<MailReplySource, "sourceMailRef" | "to" | "subject" | "expiresInSeconds">,
  issuedAtMs: number,
): Issued {
  return {
    sourceMailRef: reply.sourceMailRef,
    to: reply.to,
    subject: reply.subject,
    issuedAtMs,
    ttlMs: Math.max(0, reply.expiresInSeconds) * 1000,
  };
}

export function createMailReplyBindings(
  now: () => number = Date.now,
  fetchReply: typeof prepareMailReply = prepareMailReply,
) {
  const bySource = new Map<string, Binding>();
  const sourceByRef = new Map<string, string>();

  const find = (ref: string): Binding | null => {
    const sourceId = sourceByRef.get(ref);
    return (sourceId && bySource.get(sourceId)) || null;
  };

  const adopt = (binding: Binding, next: Issued) => {
    binding.current = next;
    binding.held = null;
    sourceByRef.set(next.sourceMailRef, binding.sourceId);
  };

  const dueInMs = (ref: string): number | null => {
    const binding = find(ref);
    if (!binding) return null;
    return binding.current.issuedAtMs + binding.current.ttlMs - REPLY_RENEW_LEAD_MS - now();
  };

  const envelopeOf = (value: Issued): MailReplyEnvelope => ({
    sourceMailRef: value.sourceMailRef,
    to: value.to,
    subject: value.subject,
  });

  return {
    register(input: MailReplyBindingInput): boolean {
      if (!input.ownerId || !isMailSourceId(input.sourceId)) return false;
      const next = issued(input.reply, input.issuedAtMs);
      const existing = bySource.get(input.sourceId);
      if (existing && existing.ownerId === input.ownerId) {
        // The same message opened again: keep one binding, newest reference.
        existing.expectedAccount = input.expectedAccount;
        adopt(existing, next);
        return true;
      }
      if (bySource.size >= MAX_BINDINGS) {
        const oldest = bySource.keys().next().value;
        if (oldest) {
          bySource.delete(oldest);
          for (const [ref, source] of sourceByRef) if (source === oldest) sourceByRef.delete(ref);
        }
      }
      bySource.set(input.sourceId, {
        ownerId: input.ownerId,
        sourceId: input.sourceId,
        expectedAccount: input.expectedAccount,
        current: next,
        held: null,
        inflight: null,
      });
      sourceByRef.set(next.sourceMailRef, input.sourceId);
      return true;
    },

    /** The newest reference and envelope for any reference this message was ever given. */
    resolve(ref: string): { envelope: MailReplyEnvelope; heldChange: boolean } | null {
      const binding = find(ref);
      return binding
        ? { envelope: envelopeOf(binding.current), heldChange: binding.held !== null }
        : null;
    },

    /** Milliseconds until a renewal is due, or null for a reference not bound here. */
    dueInMs,

    isDue(ref: string): boolean {
      const due = dueInMs(ref);
      return due !== null && due <= 0;
    },

    /**
     * Asks the server for a fresh reference for the same original message.
     * Concurrent callers share one request. Throws a typed `MailOverviewError`.
     */
    async renew(ref: string, context: RenewContext): Promise<MailReplyRenewal | null> {
      const binding = find(ref);
      if (!binding) return null;
      if (binding.ownerId !== context.ownerId) throw new MailOverviewError("account_changed");

      const request =
        binding.inflight ??
        (binding.inflight = fetchReply({
          vaultOwnerToken: context.vaultOwnerToken,
          expectedAccount: binding.expectedAccount,
          sourceId: binding.sourceId,
          signal: context.signal,
        })
          .then(({ reply }) => issued(reply, now()))
          .finally(() => {
            binding.inflight = null;
          }));
      const next = await request;
      // The binding may have been cleared (sign-out, owner change) while waiting.
      if (bySource.get(binding.sourceId) !== binding) throw new MailOverviewError("account_changed");

      const changed = next.to !== binding.current.to || next.subject !== binding.current.subject;
      if (!changed || context.adoptChanged) {
        adopt(binding, next);
        return { envelope: envelopeOf(binding.current), changed, adopted: true };
      }
      binding.held = next;
      return { envelope: envelopeOf(binding.current), changed: true, adopted: false };
    },

    clear(): void {
      bySource.clear();
      sourceByRef.clear();
    },
  };
}

export type MailReplyBindings = ReturnType<typeof createMailReplyBindings>;

"use client";

import { PREFERRED_NAME_MAX, sanitizeStyleText } from "@/lib/agent/owner-style-settings";
import { parseRecord, unwrapToolResult } from "./tool-result-envelope";
import { containsSecretSpan } from "@/lib/pkm/secret-patterns";

/** Live stream only: history rendering has no name-writing authority. */
export function beginChatPreferredNameTurn(host: {
  isCurrent: () => boolean;
  save: (name: string, beforeEffect: () => Promise<void>, mayPublish: () => boolean) => Promise<boolean>;
}) {
  let pending: string | null = null;
  let firstCall: { id: string; fingerprint: string } | null = null;
  let invalid = false;
  let finished = false;
  return {
    stage(raw: unknown, callId: string): void {
      if (finished || !host.isCurrent()) return;
      if (typeof raw === "string") {
        try { raw = JSON.parse(raw); } catch { invalid = true; return; }
      }
      const record = parseRecord(raw);
      const result = record?.status ? record : unwrapToolResult(record);
      if (!result) return;
      if (result.status !== "preferred_name_update_ready") return;
      const fingerprint = JSON.stringify(result);
      if (firstCall?.id === callId && firstCall.fingerprint === fingerprint) return;
      if (firstCall) { invalid = true; return; }
      firstCall = { id: callId, fingerprint };
      const name = result.preferred_name;
      if (!callId || typeof name !== "string" || !name || name.length > PREFERRED_NAME_MAX ||
        sanitizeStyleText(name) !== name || containsSecretSpan(name)) {
        invalid = true; return;
      }
      pending = name;
    },
    async finish(succeeded: boolean): Promise<boolean | null> {
      if (finished) return null;
      finished = true;
      if (!succeeded || invalid || !pending || !host.isCurrent()) return null;
      try {
        const saved = await host.save(pending, async () => {
          if (!host.isCurrent()) throw new DOMException("Session changed", "AbortError");
        }, host.isCurrent);
        return host.isCurrent() ? saved : null;
      } catch {
        return host.isCurrent() ? false : null;
      }
    },
  };
}

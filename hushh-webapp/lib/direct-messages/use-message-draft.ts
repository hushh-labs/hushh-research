"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { MessagesDraftService } from "@/lib/services/messages-draft-service";
import { subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";

type Identity = { userId: string | null; scope: string; vaultKey: string | null; binding: string | null; epoch?: object };
const same = (a: Identity, b: Identity) => a.userId === b.userId && a.scope === b.scope
  && a.vaultKey === b.vaultKey && a.binding === b.binding && a.epoch === b.epoch;

export function useMessageDraft(input: {
  userId: string | null; scope: string; vaultKey: string | null; enabled: boolean;
  binding?: string | null; value: string; setValue: (text: string) => void;
}) {
  const { userId, scope, vaultKey, enabled, binding = null } = input;
  const value = useRef(input.value);
  const setter = useRef(input.setValue);
  const edits = useRef(0), mounted = useRef(true);
  const session = userId ? MessagesDraftService.session(userId) : null;
  const identity = useMemo(() => ({ userId, scope, vaultKey, binding, epoch: session?.epoch }), [userId, scope, vaultKey, binding, session]);
  const latest = useRef(identity);
  useLayoutEffect(() => {
    value.current = input.value; setter.current = input.setValue; latest.current = identity;
  });
  const durable = useRef<{ identity: Identity; text: string } | null>(null);
  const localEdit = useRef<{ identity: Identity; pending: boolean } | null>(null);
  const [status, setStatus] = useState<{ identity: Identity; message: string } | null>(null);
  const available = Boolean(session && vaultKey && /^[a-f0-9]{64}$/i.test(vaultKey));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = useCallback((text: string) => {
    if (!session || !vaultKey || !available) return;
    const revision = edits.current;
    setStatus({ identity, message: "Saving draft…" });
    void MessagesDraftService.write(session, scope, vaultKey, text, binding).then(saved => {
      if (!mounted.current || !same(identity, latest.current) || edits.current !== revision) return;
      if (saved) durable.current = { identity, text };
      setStatus({ identity, message: saved ? "Draft saved" : "Draft not saved" });
    }).catch(() => {
      if (mounted.current && same(identity, latest.current) && edits.current === revision)
        setStatus({ identity, message: "Draft not saved" });
    });
  }, [session, vaultKey, available, scope, binding, identity]);
  useEffect(() => {
    if (!session || !vaultKey || !available || !enabled) return;
    if (localEdit.current?.pending && same(localEdit.current.identity, identity)) {
      localEdit.current.pending = false; save(value.current); return;
    }
    let active = true;
    const revision = edits.current;
    void MessagesDraftService.read(session, scope, vaultKey, binding).then(text => {
      if (active && same(identity, latest.current) && MessagesDraftService.isCurrent(session)
          && edits.current === revision && !value.current && text !== null) {
        value.current = text; setter.current(text); durable.current = { identity, text };
        setStatus({ identity, message: "Draft saved" });
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [session, scope, vaultKey, available, enabled, binding, identity, save]);
  useEffect(() => {
    if (!available) return;
    const leaving = (event: BeforeUnloadEvent) => {
      if (value.current && (!durable.current || !same(durable.current.identity, latest.current) || durable.current.text !== value.current)) {
        event.preventDefault(); event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [available]);
  useEffect(() => !userId ? undefined : subscribeDurableOwnerReset(owner => {
    if (owner !== userId || latest.current.userId !== userId) return;
    edits.current += 1; value.current = ""; durable.current = null; setter.current("");
    void MessagesDraftService.clearForUser(owner).catch(() => undefined);
  }), [userId]);

  const update = (next: SetStateAction<string>) => {
    const text = typeof next === "function" ? next(value.current) : next;
    edits.current += 1; value.current = text; setter.current(text);
    localEdit.current = { identity, pending: !enabled };
    if (enabled) save(text);
  };
  const retire = useCallback(async () => {
    edits.current += 1; durable.current = null; localEdit.current = null; setStatus(null);
    return session && available ? MessagesDraftService.remove(session, scope) : null;
  }, [session, available, scope]);
  const preserve = (text: string, expectedRevision?: object) => {
    if (session && vaultKey && available)
      void MessagesDraftService.write(session, scope, vaultKey, text, binding, expectedRevision).catch(() => undefined);
  };
  return { update, retire, preserve,
    isCurrent: () => !available || Boolean(session && MessagesDraftService.isCurrent(session)),
    status: status && same(status.identity, identity) ? status.message : null };
}

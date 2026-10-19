"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { PhoneCall, Mic, X } from "@/components/icons";
import { Button } from "@/lib/morphy-ux/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DirectCallsService } from "@/lib/services/direct-calls-service";
import { DirectCallSession, type CallView } from "@/lib/direct-messages/call-session";
import { NativeCallSession } from "@/lib/direct-messages/native-call-session";
import { useBackLayer } from "@/lib/navigation/back-layers";

type Props = { ownerId: string; getIdToken: () => Promise<string>; conversationId: string | null;
  peerName: string; personRef?: string | null; canCall: boolean; className: string; buttonTarget?: HTMLElement | null };

/** Browser transport and OS-owned iOS calling share the same presentation. */
export function DirectCallControl(props: Props) {
  const token = useRef(props.getIdToken);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { token.current = props.getIdToken; }, [props.getIdToken]);
  const session = useRef<DirectCallSession | NativeCallSession | null>(null);
  const epoch = useRef(0);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<CallView>({ call: null, error: null, muted: false, mediaConnected: false });
  const [verification, setVerification] = useState<{ fingerprint: string; resolve: (accepted: boolean) => void } | null>(null);
  const pending = useRef<((accepted: boolean) => void) | null>(null);
  const verified = useRef(new Map<string, string>());
  const closeVerification = () => { pending.current?.(false); pending.current = null; setVerification(null); };
  useBackLayer("/one/messages", verification ? 5 : 0, () => { closeVerification(); return true; });
  useBackLayer("/one/messages", view.call ? 4 : 0, () => { void session.current?.end(false, view.call?.id); return true; });

  useEffect(() => {
    let current = true;
    epoch.current += 1;
    setBusy(false);
    setVerification(null);
    setAvailable(false);
    setView({ call: null, error: null, muted: false, mediaConnected: false });
    verified.current.clear();
    const native = Capacitor.isNativePlatform();
    if (native && Capacitor.getPlatform() !== "ios") return;
    const verifyPeer = async (conversationId: string, fingerprint: string) => {
      if (!current) return false;
      if (!native && verified.current.get(conversationId) === fingerprint) return true;
      const accepted = await new Promise<boolean>(resolve => {
        pending.current?.(false);
        pending.current = resolve;
        setVerification({ fingerprint, resolve });
      });
      if (current && accepted) verified.current.set(conversationId, fingerprint);
      return current && accepted;
    };
    const publish = (next: CallView) => { if (current) {
      if (!next.call) { pending.current?.(false); pending.current = null; setVerification(null); }
      setView(next);
    } };
    const service = new DirectCallsService(props.ownerId, () => token.current());
    const engine = native ? new NativeCallSession(props.ownerId, publish, verifyPeer)
      : new DirectCallSession(service, publish, verifyPeer);
    session.current = engine;
    const initialize = native ? async () => {
      const available = await (engine as NativeCallSession).initialize();
      if (current) setAvailable(available);
    } : async () => {
      const capabilities = await service.capabilities();
      if (!current || !capabilities.available) return;
      await engine.initialize();
      if (current) setAvailable(true);
    };
    void initialize().catch(() => { /* Failed admission keeps the control unavailable. */ });
    const leave = () => { pending.current?.(false); pending.current = null; setVerification(null); void engine.end(); };
    const hidden = () => { if (document.visibilityState === "hidden") leave(); };
    if (!native) {
      window.addEventListener("pagehide", leave);
      document.addEventListener("visibilitychange", hidden);
    }
    return () => {
      current = false;
      epoch.current += 1;
      pending.current?.(false); pending.current = null;
      engine.dispose();
      if (session.current === engine) session.current = null;
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [props.ownerId]);

  const button = <button ref={trigger} type="button" className={props.className} aria-label="Start voice call"
      title={available ? "Start voice call" : "Calls are not available yet"}
      disabled={!available || !props.canCall || (!props.conversationId && !props.personRef) || busy || Boolean(view.call)}
      onClick={() => {
        if ((!props.conversationId && !props.personRef) || !session.current) return;
        setBusy(true);
        const started = epoch.current;
        void session.current.start(props.conversationId,props.personRef).catch(() => undefined).finally(() => { if (started === epoch.current) setBusy(false); });
      }}><PhoneCall className="h-4 w-4" aria-hidden="true" /></button>;
  return <>
    {props.buttonTarget === undefined ? button : props.buttonTarget ? createPortal(button, props.buttonTarget) : null}
    <Dialog modal open={Boolean(verification || view.call || view.error)} onOpenChange={open => {
      if (open) return;
      if (verification) closeVerification();
      else if (view.call) void session.current?.end(false, view.call.id);
      else setView(previous => ({ ...previous, error: null }));
    }}>
      <DialogContent aria-modal="true" onCloseAutoFocus={event => {
        event.preventDefault();
        const target = trigger.current;
        if (target?.isConnected && !target.disabled) target.focus();
        else document.querySelector<HTMLElement>("[data-message-call-focus-anchor]")?.focus();
      }}>
        {verification ? <>
          <DialogHeader><DialogTitle>Verify this conversation</DialogTitle>
            <DialogDescription>Compare this security code with the other person using a trusted channel. A changed device changes the code.</DialogDescription>
          </DialogHeader>
          <code className="break-all rounded-lg bg-muted p-4 text-center">{verification.fingerprint.match(/.{1,4}/g)?.join(" ")}</code>
          <Button onClick={() => { verification.resolve(true); pending.current = null; setVerification(null); }}>We compared the code</Button>
          <Button variant="muted" onClick={closeVerification}>Cancel</Button>
        </> : view.error ? <>
          <DialogHeader><DialogTitle>Call ended</DialogTitle><DialogDescription role="status">{view.error}</DialogDescription></DialogHeader>
          <Button onClick={() => setView(previous => ({ ...previous, error: null }))}>Close</Button>
        </> : <>
          <DialogHeader><DialogTitle>{view.call?.peerDisplayName || (view.call?.conversationId === props.conversationId ? props.peerName : "Voice call")}</DialogTitle>
            <DialogDescription>{view.mediaConnected ? "Connected" : view.call?.state === "ringing" ? view.call.isCaller ? "Calling..." : "Incoming voice call" : "Connecting..."}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Encrypted audio / Private relay</p>
          {!view.call?.isCaller && view.call?.state === "ringing" ? <Button disabled={busy} onClick={() => {
            setBusy(true);
            const started = epoch.current;
            void session.current?.answer(view.call?.id).catch(() => undefined).finally(() => { if (started === epoch.current) setBusy(false); });
          }}>Answer</Button> : null}
          {view.mediaConnected ? <Button variant="muted" aria-pressed={view.muted} onClick={() => session.current?.mute(view.call?.id)}><Mic className="h-4 w-4" />{view.muted ? "Unmute" : "Mute"}</Button> : null}
          <Button variant="destructive" onClick={() => { void session.current?.end(true, view.call?.id); }}><X className="h-4 w-4" />{view.call?.state === "ringing" && !view.call.isCaller ? "Decline" : "End call"}</Button>
        </>}
      </DialogContent>
    </Dialog>
  </>;
}

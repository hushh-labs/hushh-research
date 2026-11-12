"use client";

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { PhoneCall, Mic, X } from "@/components/icons";
import { Button } from "@/lib/morphy-ux/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DirectCallsService } from "@/lib/services/direct-calls-service";
import { DirectCallSession, type CallView } from "@/lib/direct-messages/call-session";
import { NativeCallSession } from "@/lib/direct-messages/native-call-session";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { subscribeAuthSessionGeneration, getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/firebase/auth-context";
import { registerSmsCallHost } from "@/lib/direct-messages/sms-call-escalation";
import { toast } from "sonner";

type Props = { ownerId: string; getIdToken: () => Promise<string>; conversationId: string | null;
  peerName: string; personRef?: string | null; canCall: boolean; className: string; buttonTarget?: HTMLElement | null };

type CallControls = { available: boolean; busy: boolean; inCall: boolean;
  start: (request: Props, button: HTMLButtonElement) => void };
const CallControlsContext = createContext<CallControls | null>(null);

function CallButton({ request, controls }: { request: Props; controls: CallControls }) {
  const button = <button type="button" className={request.className} aria-label="Start voice call"
      title={controls.available ? "Start voice call" : "Calls are not available yet"}
      disabled={!controls.available || !request.canCall || (!request.conversationId && !request.personRef) || controls.busy || controls.inCall}
      onClick={(event) => controls.start(request, event.currentTarget)}><PhoneCall className="h-4 w-4" aria-hidden="true" /></button>;
  return request.buttonTarget === undefined ? button : request.buttonTarget ? createPortal(button, request.buttonTarget) : null;
}

export function DirectCallControl(props: Props) {
  const shared = useContext(CallControlsContext);
  if (shared) return <CallButton request={props} controls={shared} />;
  return <CallHost ownerId={props.ownerId} getIdToken={props.getIdToken} manual={props} />;
}

export function SharedDirectCallProvider({ children }: { children: ReactNode }) {
  const { userId, user } = useAuth();
  return <CallHost ownerId={userId ?? ""} getIdToken={async () => {
    if (!user) throw new Error("Sign in to make a call.");
    return user.getIdToken();
  }}>{children}</CallHost>;
}

/** One engine and dialog for each signed-in owner, across app routes. */
function CallHost(props: Pick<Props, "ownerId" | "getIdToken"> & { manual?: Props; children?: ReactNode }) {
  const authGeneration = useSyncExternalStore(subscribeAuthSessionGeneration, getAuthSessionGeneration, () => null);
  const pathname = usePathname() ?? "/one/messages";
  const token = useRef(props.getIdToken);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const manualPeer = useRef<{ conversationId: string | null; peerName: string } | null>(null);
  useLayoutEffect(() => { token.current = props.getIdToken; }, [props.getIdToken]);
  const session = useRef<DirectCallSession | NativeCallSession | null>(null);
  const epoch = useRef(0);
  const starting = useRef(false);
  const activeCall = useRef(false);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<CallView>({ call: null, error: null, muted: false, mediaConnected: false });
  const [verification, setVerification] = useState<{ fingerprint: string; resolve: (accepted: boolean) => void } | null>(null);
  const pending = useRef<((accepted: boolean) => void) | null>(null);
  const verified = useRef(new Map<string, string>());
  const closeVerification = () => { pending.current?.(false); pending.current = null; setVerification(null); };
  useBackLayer(pathname, verification ? 5 : 0, () => { closeVerification(); return true; });
  useBackLayer(pathname, view.call ? 4 : 0, () => { void session.current?.end(false, view.call?.id); return true; });

  useLayoutEffect(() => {
    let current = true;
    let releaseSms: (() => void) | undefined;
    epoch.current += 1;
    starting.current = false;
    activeCall.current = false;
    setBusy(false);
    setVerification(null);
    setAvailable(false);
    setView({ call: null, error: null, muted: false, mediaConnected: false });
    verified.current.clear();
    manualPeer.current = null;
    if (!props.ownerId) return;
    const native = Capacitor.isNativePlatform();
    if (native && !["ios", "android"].includes(Capacitor.getPlatform())) return;
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
      activeCall.current = Boolean(next.call);
      if (!next.call) { pending.current?.(false); pending.current = null; setVerification(null); }
      setView(next);
    } };
    const service = new DirectCallsService(props.ownerId, () => token.current());
    const engine = native ? new NativeCallSession(props.ownerId, publish, verifyPeer)
      : new DirectCallSession(service, publish, verifyPeer);
    session.current = engine;
    const armEscalation = (deviceId: string) => {
      const unavailable = () => toast.error("Automatic call unavailable. Your SMS alert is still active.");
      releaseSms = registerSmsCallHost({
        ownerId: props.ownerId, deviceId, unavailable,
        start: (intent) => {
          if (!current) return;
          if (starting.current || activeCall.current) { unavailable(); return; }
          starting.current = true;
          setBusy(true);
          trigger.current = null;
          manualPeer.current = null;
          void engine.start(null, null, intent).then((started) => {
            if (current && !started) unavailable();
          }).catch(() => { if (current) unavailable(); }).finally(() => {
            if (!current) return;
            starting.current = false;
            setBusy(false);
          });
        },
      });
    };
    const initialize = native ? async () => {
      const nativeEngine = engine as NativeCallSession;
      const available = await nativeEngine.initialize();
      if (current) setAvailable(available);
      if (!current || !available || !nativeEngine.deviceId) return;
      const capabilities = await service.capabilities();
      if (current && capabilities.smsEscalationAvailable) armEscalation(nativeEngine.deviceId);
    } : async () => {
      const capabilities = await service.capabilities();
      if (!current || !capabilities.available) return;
      await engine.initialize();
      if (current) setAvailable(true);
      if (current && capabilities.smsEscalationAvailable && service.identity) armEscalation(service.identity.deviceId);
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
      releaseSms?.();
      epoch.current += 1;
      pending.current?.(false); pending.current = null;
      engine.dispose();
      if (session.current === engine) session.current = null;
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [props.ownerId, authGeneration]);

  const controls = useMemo<CallControls>(() => ({
    available, busy, inCall: Boolean(view.call),
    start: (request, button) => {
      if (request.ownerId !== props.ownerId || !session.current || starting.current || activeCall.current) return;
      starting.current = true;
      trigger.current = button;
      manualPeer.current = request;
      setBusy(true);
      const started = epoch.current;
      void session.current.start(request.conversationId, request.personRef).catch(() => undefined)
        .finally(() => {
          if (started !== epoch.current) return;
          starting.current = false;
          setBusy(false);
        });
    },
  }), [available, busy, props.ownerId, view.call]);
  return <CallControlsContext.Provider value={controls}>
    {props.children}
    {props.manual ? <CallButton request={props.manual} controls={controls} /> : null}
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
          <DialogHeader><DialogTitle>{view.call?.peerDisplayName ||
            (view.call?.conversationId === (manualPeer.current ?? props.manual)?.conversationId
              ? (manualPeer.current ?? props.manual)?.peerName : null) || "Voice call"}</DialogTitle>
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
  </CallControlsContext.Provider>;
}

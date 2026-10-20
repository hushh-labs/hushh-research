"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Keyboard } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { isComputerUseTerminal, manualBrowserInputAllowed, type ManualBrowserInput } from "@/lib/computer-use/contracts";
import { computerUsePoint, createComputerUseCanvas } from "@/lib/computer-use/preview-canvas";
import type { ComputerUseTaskController } from "@/lib/computer-use/task-controller";
import { ComputerUseViewport } from "./computer-use-viewport";

/** Frames and credential entry stay in this component's canvas/DOM memory. */
export function ComputerUsePreview({ controller }: { controller: ComputerUseTaskController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const focusPoint = useRef<{ x: number; y: number } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [visible, setVisible] = useState(true);
  const [painted, setPainted] = useState<{ epoch: number; width: number; height: number } | null>(null);
  const displayed = useRef<typeof painted>(null);
  const owner = state.verified && !state.controlling && manualBrowserInputAllowed(state.snapshot);
  const viewport = state.snapshot?.viewport;
  const manual = owner && visible && !unavailable && painted !== null && painted.epoch === state.snapshot?.controlEpoch
    && (!viewport || (painted.width === viewport.width && painted.height === viewport.height));
  const { verified } = state;
  const phase = state.snapshot?.phase;
  const capability = state.snapshot?.capability;
  const controlEpoch = state.snapshot?.controlEpoch;
  const publicOnly = state.snapshot?.publicResearchOnly === true;

  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);

  useEffect(() => {
    const surface = canvas.current;
    const entry = keyboard.current;
    displayed.current = null;
    setPainted(null);
    if (!surface || !visible || !verified || state.controlling || !phase
      || capability !== "ready" || isComputerUseTerminal(phase)) return;
    const renderer = createComputerUseCanvas(surface, (frame) => controller.acceptsFrame(frame), (frame) => {
      const previous = displayed.current;
      if (previous?.epoch === frame.controlEpoch && previous.width === frame.width && previous.height === frame.height) return;
      const ready = { epoch: frame.controlEpoch, width: frame.width, height: frame.height };
      displayed.current = ready;
      setPainted(ready); // Readiness transition only, never one React update per frame.
    });
    const session = new AbortController();
    const fail = () => {
      if (!session.signal.aborted) {
        renderer.clear();
        displayed.current = null;
        pointer.current = null;
        focusPoint.current = null;
        if (entry) entry.value = "";
        setUnavailable(true);
        session.abort();
      }
    };
    const start = () => {
      setUnavailable(false);
      void controller.transport.watchFrames(controller.binding, session.signal, (frame) => {
        void renderer.paint(frame).catch(fail);
      }).catch(fail);
    };
    // A hidden preview must not hold remote compute awake. Returning uses fresh
    // admission/status rather than resuming an old stream implicitly.
    if (!document.hidden) start();
    return () => {
      session.abort();
      renderer.close();
      displayed.current = null;
      pointer.current = null;
      focusPoint.current = null;
      if (entry) entry.value = "";
    };
  }, [controller, visible, verified, controlEpoch, capability, phase, state.controlling]);

  useEffect(() => {
    const surface = canvas.current;
    if (!surface || !manual) return;
    const scroll = (event: WheelEvent) => {
      const current = controller.getSnapshot();
      if (displayed.current !== painted || !current.verified || current.controlling || !manualBrowserInputAllowed(current.snapshot)
        || (!event.deltaY && !event.deltaX)) return;
      event.preventDefault();
      const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
      const delta = vertical ? event.deltaY : event.deltaX;
      void controller.input({ operation: "scroll", direction: vertical ? (delta > 0 ? "down" : "up") : (delta > 0 ? "right" : "left"),
        magnitude: Math.max(1, Math.min(2000, Math.round(Math.abs(delta)))) }).catch(() => {
        morphyToast.error("Browser control paused. Check the connection before continuing.");
      });
    };
    // The cancellation applies only to the remote canvas, never the app scroll root.
    surface.addEventListener("wheel", scroll, { passive: false });
    return () => surface.removeEventListener("wheel", scroll);
  }, [controller, manual, painted]);

  function send(action: ManualBrowserInput): void {
    if (!manual || displayed.current !== painted) return;
    if (publicOnly && (action.operation === "type" || action.operation === "keys")) return;
    void controller.input(action).catch(() => {
      morphyToast.error("Browser control paused. Check the connection before continuing.");
    });
  }

  return (
    <div className="flex min-h-0 flex-col gap-3" data-computer-use-preview>
      {publicOnly ? <p className="text-sm text-muted-foreground">Public browsing only. Sign-in isn’t enabled yet.</p> : null}
      {state.snapshot?.controlOwner === "owner" && viewport ? (
        <ComputerUseViewport controller={controller} surface={surface}
          disabled={!owner || state.pending || Boolean(state.snapshot.review)} />
      ) : null}
      <div ref={surface} className="relative flex min-w-0 justify-center overflow-hidden rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-separator)] bg-muted">
        <canvas
          ref={canvas} width={viewport?.width ?? 1280} height={viewport?.height ?? 720}
          className="block h-auto max-h-[65dvh] w-auto max-w-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          tabIndex={manual ? 0 : -1}
          aria-label={manual ? "Browser screen. Click or touch to control." : "Browser screen. Take control to interact."}
          onPointerDown={(event) => {
            if (!manual || displayed.current !== painted || event.button !== 0) return;
            pointer.current = computerUsePoint(event.currentTarget, event.clientX, event.clientY);
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerUp={(event) => {
            if (!manual || displayed.current !== painted) { pointer.current = null; return; }
            const from = pointer.current;
            const to = computerUsePoint(event.currentTarget, event.clientX, event.clientY);
            pointer.current = null;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
            if (!from || !to) return;
            focusPoint.current = to;
            if (Math.hypot(to.x - from.x, to.y - from.y) > 8) {
              if (event.pointerType === "touch") {
                const vertical = Math.abs(to.y - from.y) >= Math.abs(to.x - from.x);
                const delta = vertical ? from.y - to.y : from.x - to.x;
                send({ operation: "scroll", direction: vertical ? (delta > 0 ? "down" : "up") : (delta > 0 ? "right" : "left"),
                  magnitude: Math.max(1, Math.min(2000, Math.round(Math.abs(delta)))) });
              } else send({ operation: "drag", ...from, destination_x: to.x, destination_y: to.y });
            } else send({ operation: "click", ...to });
          }}
          onPointerCancel={() => { pointer.current = null; }}
          onKeyDown={(event) => {
            if (!manual || publicOnly || event.key === "Tab") return;
            if (event.nativeEvent.isComposing) return;
            if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
            if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) {
              event.preventDefault();
              const modifiers = [event.ctrlKey && "Control", event.metaKey && "Meta", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean) as string[];
              if (modifiers.length < 4) send({ operation: "keys", keys: [...modifiers, event.key] });
            } else if (focusPoint.current) {
              event.preventDefault();
              send({ operation: "type", ...focusPoint.current, text: event.key, clear_before_typing: false, focus_existing: true });
            }
          }}
        />
        {unavailable ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background px-4 text-center text-sm text-muted-foreground" role="status">
            Preview disconnected. Close and reopen it to reconnect.
          </div>
        ) : null}
      </div>
      {state.snapshot?.controlOwner === "owner" && !publicOnly ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ShellActionSurface variant="pill" className="min-h-11" disabled={!manual}
            onClick={() => send({ operation: "keys", keys: ["Tab"] })}>
            Next field
          </ShellActionSurface>
          <ShellActionSurface variant="pill" className="min-h-11" disabled={!manual}
            onClick={() => {
              if (focusPoint.current) keyboard.current?.focus();
              else morphyToast.info("Select a field in the browser first.");
            }} aria-label="Open browser keyboard">
            <Keyboard className="size-4" aria-hidden />Keyboard
          </ShellActionSurface>
          <textarea ref={keyboard} aria-label="Type in browser" autoComplete="off" autoCorrect="off"
            autoCapitalize="none" spellCheck={false} disabled={!manual}
            className="absolute size-px overflow-hidden opacity-0"
            onChange={(event) => {
              if ((event.nativeEvent as InputEvent).isComposing) return;
              const text = event.currentTarget.value;
              event.currentTarget.value = "";
              if (focusPoint.current && text && text.length <= 4096) {
                send({ operation: "type", ...focusPoint.current, text, clear_before_typing: false, focus_existing: true });
              }
            }}
            onCompositionEnd={(event) => {
              const text = event.currentTarget.value;
              event.currentTarget.value = "";
              if (focusPoint.current && text && text.length <= 4096) {
                send({ operation: "type", ...focusPoint.current, text, clear_before_typing: false, focus_existing: true });
              }
            }}
            onKeyDown={(event) => {
              if (["Enter", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape"].includes(event.key)) {
                event.preventDefault();
                send({ operation: "keys", keys: [event.key] });
              }
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

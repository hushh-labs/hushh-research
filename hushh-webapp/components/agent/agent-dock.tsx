"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Dock = {
  host: HTMLDivElement | null;
  setHost: (host: HTMLDivElement | null) => void;
  composerVisible: boolean;
  suppressed: boolean;
  claim: (id: symbol, visible: boolean, suppressed: boolean) => void;
  release: (id: symbol) => void;
};

const DockContext = createContext<Dock | null>(null);
const VoiceSurfaceContext = createContext(false);

/** Presentation only. Drafts, submission and microphone ownership stay with
 * their existing feature authorities; nothing is copied into a shell store. */
export function AgentDockProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [composerVisible, setComposerVisible] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  const current = useRef<symbol | null>(null);
  const claim = useCallback((id: symbol, visible: boolean, suppress: boolean) => {
    current.current = id;
    setComposerVisible(visible);
    setSuppressed(suppress);
  }, []);
  const release = useCallback((id: symbol) => {
      if (current.current !== id) return;
      current.current = null;
      setComposerVisible(false);
      setSuppressed(false);
  }, []);
  const value = useMemo<Dock>(() => ({ host, setHost, composerVisible, suppressed, claim, release }), [host, composerVisible, suppressed, claim, release]);
  return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}

export function AgentDockVoiceBoundary({ children }: { children: ReactNode }) {
  return <VoiceSurfaceContext.Provider value>{children}</VoiceSurfaceContext.Provider>;
}

export function useAgentDockSurface() {
  const dock = useContext(DockContext);
  const persistent = useContext(VoiceSurfaceContext);
  return persistent ? dock : null;
}

/** The canonical composer is projected into the same retained bar. Embedded
 * workspaces keep their local composer. A missing host is not a second input. */
export function AgentDockPortal({ enabled, visible, suppressed = false, children }: {
  enabled: boolean;
  visible: boolean;
  suppressed?: boolean;
  children: ReactNode;
}) {
  const dock = useContext(DockContext);
  const id = useRef(Symbol("chat-composer"));
  const claim = dock?.claim;
  const release = dock?.release;
  useLayoutEffect(() => {
    if (!enabled || !claim || !release) return;
    const identity = id.current;
    claim(identity, visible, suppressed);
    return () => release(identity);
  }, [enabled, visible, suppressed, claim, release]);
  if (!enabled) return children;
  return dock?.host ? createPortal(children, dock.host) : null;
}

export function useAgentDockHost() { return useContext(DockContext)?.host ?? null; }

/** Geometry only: include the retained voice panel as well as the form. The
 * hidden form's zero rectangle cannot describe the visible dock's occlusion. */
export function useAgentDockFrame() {
  const host = useAgentDockHost();
  return useMemo(() => host?.closest<HTMLDivElement>("[data-agent-bar-shell]") ?? null, [host]);
}

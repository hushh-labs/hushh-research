"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type ShadowDomSurfaceProps = {
  children: React.ReactNode;
  mode?: ShadowRootMode;
};

export function ShadowDomSurface({
  children,
  mode = "closed",
}: ShadowDomSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);

  useEffect(() => {
    if (!hostRef.current || shadowRoot) {
      return;
    }

    const root = hostRef.current.attachShadow({
      mode,
    });

    setShadowRoot(root);
  }, [mode, shadowRoot]);

  return (
    <div ref={hostRef}>
      {shadowRoot ? createPortal(children, shadowRoot) : null}
    </div>
  );
}
"use client";

/**
 * Single source of truth for the RIA premium surface scope attribute.
 *
 * Writes body[data-persona-surface="ria"] so the scoped token block in
 * globals.css retints the canvas + chrome + page to the Apple-clean palette.
 * Scope = every /ria/* route, PLUS the shared Connect surface (/marketplace)
 * WHEN the active persona is RIA. Because Connect is only retinted for a RIA
 * viewer, One/investor see the marketplace byte-identical (attribute unset).
 *
 * Rendered inside PersonaProvider (it needs activePersona), which is why this is
 * a dedicated component rather than an effect in the outer AppShellFrame.
 */

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { usePersonaState } from "@/lib/persona/persona-context";
import { isRiaRoute, ROUTES } from "@/lib/navigation/routes";

export function RiaSurfaceScopeSync() {
  const pathname = usePathname();
  const { activePersona } = usePersonaState();

  useEffect(() => {
    if (typeof document === "undefined") return;
    const path = pathname ?? "";
    const isConnectAsRia =
      activePersona === "ria" &&
      (path === ROUTES.MARKETPLACE || path.startsWith(`${ROUTES.MARKETPLACE}/`));
    const isRia = isRiaRoute(path) || isConnectAsRia;

    const { body } = document;
    if (isRia) {
      body.dataset.personaSurface = "ria";
    } else if (body.dataset.personaSurface === "ria") {
      delete body.dataset.personaSurface;
    }
  }, [pathname, activePersona]);

  return null;
}

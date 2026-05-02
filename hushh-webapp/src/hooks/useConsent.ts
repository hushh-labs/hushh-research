"use client";

import { useEffect, useState } from "react";
import type { SensitivePermission } from "../components/privacy/permission-gate/permissionRules";

type ConsentStatus = "loading" | "granted" | "denied" | "error";

interface ActiveConsentResponse {
  active?: boolean;
  granted?: boolean;
  permissions?: string[];
  scopes?: string[];
}

export function useConsent() {
  const [status, setStatus] = useState<ConsentStatus>("loading");
  const [permissions, setPermissions] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    async function loadConsentState() {
      try {
        const response = await fetch("/api/consent/active", {
          method: "GET",
          credentials: "include",
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`Consent API failed with ${response.status}`);
        }

        const data = (await response.json()) as ActiveConsentResponse;

        const grantedPermissions = new Set<string>([
          ...(data.permissions ?? []),
          ...(data.scopes ?? []),
        ]);

        if (cancelled) return;

        setPermissions(grantedPermissions);
        setStatus(data.active || data.granted ? "granted" : "denied");
      } catch {
        if (cancelled) return;

        setPermissions(new Set());
        setStatus("error");
      }
    }

    void loadConsentState();

    return () => {
      cancelled = true;
    };
  }, []);

  const hasConsentFor = (permission: SensitivePermission) => {
    if (status !== "granted") return false;
    return permissions.has(permission);
  };

  return {
    hasConsentFor,
    isLoading: status === "loading",
    status,
  };
}
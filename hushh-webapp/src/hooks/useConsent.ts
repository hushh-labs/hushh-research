"use client";

import { useMemo, useState } from "react";
import type { SensitivePermission } from "../components/privacy/permission-gate/permissionRules";

type ConsentStatus = "loading" | "granted" | "denied" | "error";

export function useConsent() {
  const [status] = useState<ConsentStatus>("denied");

  const permissions = useMemo(() => new Set<string>(), []);

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
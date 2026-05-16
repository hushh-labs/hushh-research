"use client";

import type { ReactNode } from "react";

import { useVault } from "@/lib/vault/vault-context";

import { PermissionLockedState } from "./permission-locked-state";
import { permissionRules, type SensitivePermission } from "./permission-rules";

export type PermissionGateState = "loading" | "allowed" | "restricted" | "unavailable";

interface PermissionGateProps {
  permission: SensitivePermission;
  state?: PermissionGateState;
  children: ReactNode;
}

export function PermissionGate({ permission, state, children }: PermissionGateProps) {
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const rule = permissionRules[permission];
  const resolvedState = state ?? (isVaultUnlocked && vaultOwnerToken ? "allowed" : "restricted");

  if (resolvedState === "loading") {
    return null;
  }

  if (resolvedState === "restricted" || resolvedState === "unavailable") {
    return <PermissionLockedState rule={rule} state={resolvedState} />;
  }

  return <>{children}</>;
}

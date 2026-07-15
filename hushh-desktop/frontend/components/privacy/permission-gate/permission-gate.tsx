"use client";

import type { ReactNode } from "react";

import { useVault } from "@/lib/vault/vault-context";

import { PermissionLockedState } from "./permission-locked-state";
import { permissionRules, type SensitivePermission } from "./permission-rules";

interface PermissionGateProps {
  permission: SensitivePermission;
  children: ReactNode;
}

export function PermissionGate({ permission, children }: PermissionGateProps) {
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const rule = permissionRules[permission];

  if (!isVaultUnlocked || !vaultOwnerToken) {
    return <PermissionLockedState rule={rule} />;
  }

  return <>{children}</>;
}

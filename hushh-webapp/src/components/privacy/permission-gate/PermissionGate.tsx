"use client";

import { ReactNode } from "react";
import PermissionLockedState from "./PermissionLockedState";
import { permissionRules, SensitivePermission } from "./permissionRules";

interface Props {
  permission: SensitivePermission;
  hasConsent: boolean;
  isLoading?: boolean;
  children: ReactNode;
}

export default function PermissionGate({
  permission,
  hasConsent,
  isLoading = false,
  children,
}: Props) {
  const rule = permissionRules[permission];

  if (isLoading) {
    return null;
  }

  if (!hasConsent) {
    return <PermissionLockedState rule={rule} />;
  }

  return <>{children}</>;
}
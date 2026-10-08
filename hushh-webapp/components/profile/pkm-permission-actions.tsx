"use client";
import { Button } from "@/lib/morphy-ux/morphy";
import { Switch } from "@/components/ui/switch";
import { EyeIcon as Eye, ArrowsClockwiseIcon as RefreshCw } from "@/components/icons";
import { ScopeTariffEditor } from "@/components/consent/scope-tariff-editor";
import { consentScopeForPermission } from "@/lib/personal-knowledge-model/slice-publishing";
import type { PkmDomainPermissionPresentation } from "@/lib/profile/pkm-profile-presentation";
import type { PkmVisibilityPosture } from "@/lib/services/personal-knowledge-model-service";

/** Exact-scope pricing, preview and existing visibility control share one row. */
export function PkmPermissionActions({ permission, pending, onPreview, onToggle }: {
  permission: PkmDomainPermissionPresentation; pending: boolean;
  onPreview: (permission: PkmDomainPermissionPresentation) => void;
  onToggle: (permission: PkmDomainPermissionPresentation, posture: PkmVisibilityPosture) => void;
}) {
  const disabled = pending || Boolean(permission.disabledReason);
  return (
                  <div className="flex items-center gap-2">
                    {permission.scopeHandle && !permission.disabledReason ? (
                      <ScopeTariffEditor
                        scopeHandle={permission.scopeHandle}
                        machineScope={consentScopeForPermission(permission.domainKey, permission.topLevelScopePath)}
                        label={permission.label}
                      />
                    ) : null}
                    <Button
                      type="button"
                      variant="none"
                      effect="fade"
                      size="sm"
                      onClick={() => onPreview(permission)}
                      aria-label={`View ${permission.label} information`}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    {pending ? (
                      <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Switch
                        checked={permission.visibilityPosture === "consent_required"}
                        disabled={disabled}
                        onCheckedChange={(next) =>
                          onToggle(
                            permission,
                            (next ? "consent_required" : "private") as PkmVisibilityPosture,
                          )
                        }
                        aria-label={`Ask before sharing ${permission.label}`}
                      />
                    )}
                  </div>
  );
}

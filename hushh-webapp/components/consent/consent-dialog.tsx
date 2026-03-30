// components/consent/consent-dialog.tsx

/**
 * Consent Dialog Component
 *
 * Per-action consent UI following Bible principles:
 * "Consent is not inferred. It is declared, signed, scoped."
 *
 * Shows user exactly what data an agent wants to access,
 * then issues a consent token upon approval.
 */

"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/lib/morphy-ux/morphy";
import { Shield, CheckCircle, XCircle, Clock, Lock } from "lucide-react";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { Icon } from "@/lib/morphy-ux/ui";

// ============================================================================
// Types
// ============================================================================

export interface ConsentRequest {
  agentId: string;
  agentName: string;
  agentIcon?: string;
  scope: string;
  scopeDescription: string;
  /** Display metadata from backend scope label registry */
  scopeLabel?: string;
  scopeIconName?: string;
  scopeColorHex?: string;
  dataFields?: string[];
  expiresInDays?: number;
}

export interface ConsentDialogProps {
  open: boolean;
  request: ConsentRequest;
  onGrant: () => Promise<void>;
  onDeny: () => void;
  loading?: boolean;
}

// ============================================================================
// Dynamic Scope Display Resolution
// ============================================================================

/**
 * Resolve scope display info from request metadata (enriched by backend)
 * or fall back to a humanized version of the raw scope string.
 */
function resolveScopeDisplay(request: ConsentRequest): {
  title: string;
  description: string;
  colorHex: string | null;
} {
  // Prefer backend-provided label (from scope_helpers.get_scope_display_metadata)
  if (request.scopeLabel) {
    return {
      title: request.scopeLabel,
      description: request.scopeDescription,
      colorHex: request.scopeColorHex ?? null,
    };
  }

  // Humanize raw scope string as fallback
  const humanized = request.scope
    .replace(/^attr\./, "")
    .replace(/\.\*$/, "")
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return {
    title: humanized || request.scope,
    description: request.scopeDescription,
    colorHex: null,
  };
}

// ============================================================================
// Component
// ============================================================================

export function ConsentDialog({
  open,
  request,
  onGrant,
  onDeny,
  loading = false,
}: ConsentDialogProps) {
  const [isGranting, setIsGranting] = useState(false);

  const scopeInfo = resolveScopeDisplay(request);

  const handleGrant = async () => {
    setIsGranting(true);
    try {
      await onGrant();
    } finally {
      setIsGranting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onDeny()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-12 w-12 rounded-full bg-linear-to-br from-blue-500 to-purple-600 flex items-center justify-center text-2xl shadow-lg">
              {request.agentIcon || "🤖"}
            </div>
            <div>
              <DialogTitle className="text-lg">{request.agentName}</DialogTitle>
              <DialogDescription className="text-sm">
                is requesting permission
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Scope Info */}
        <div className="space-y-4 py-4">
          <div
            className="flex items-start gap-3 p-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200/60 dark:border-blue-800/40"
            style={scopeInfo.colorHex ? {
              backgroundColor: `${scopeInfo.colorHex}08`,
              borderColor: `${scopeInfo.colorHex}20`,
            } : undefined}
          >
            <div
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
              style={scopeInfo.colorHex ? {
                backgroundColor: `${scopeInfo.colorHex}18`,
              } : undefined}
            >
              <Icon
                icon={Shield}
                size="md"
                className="text-blue-500"
                style={scopeInfo.colorHex ? { color: scopeInfo.colorHex } : undefined}
              />
            </div>
            <div>
              <p className="font-medium text-foreground">
                {scopeInfo.title}
              </p>
              <p className="text-sm text-muted-foreground">
                {scopeInfo.description}
              </p>
            </div>
          </div>

          {/* Data Fields */}
          {request.dataFields && request.dataFields.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                This will include:
              </p>
              <ul className="text-sm space-y-1">
                {request.dataFields.map((field, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <Icon icon={Lock} size={12} className="text-green-500" />
                    <span>{field}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Expiry Info */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Icon icon={Clock} size="sm" />
            <span>Permission expires in {request.expiresInDays || 7} days</span>
          </div>
        </div>

        {/* Security Note */}
        <div className="text-xs text-muted-foreground bg-gray-50 dark:bg-gray-900 p-3 rounded-lg">
          🔐 Your data will be encrypted end-to-end. Only you can decrypt it.
        </div>

        <DialogFooter className="flex gap-2 sm:gap-2">
          <Button
            variant="none"
            onClick={onDeny}
            disabled={isGranting || loading}
            className="flex-1"
          >
            <Icon icon={XCircle} size="sm" className="mr-2" />
            Deny
          </Button>
          <Button
            onClick={handleGrant}
            disabled={isGranting || loading}
            className="flex-1 bg-linear-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
          >
            {isGranting ? (
              <>
              <HushhLoader variant="compact" className="mr-2 text-white" />
                Granting...
              </>
            ) : (
              <>
                <Icon icon={CheckCircle} size="sm" className="mr-2" />
                Allow
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Hook for Easy Usage
// ============================================================================

import { useCallback } from "react";

export interface UseConsentReturn {
  requestConsent: (request: ConsentRequest) => Promise<boolean>;
}

/**
 * Hook to request consent in components
 *
 * Usage:
 * const { requestConsent } = useConsent();
 * const granted = await requestConsent({
 *   agentId: 'agent_food_dining',
 *   agentName: 'Food & Dining',
 *   scope: 'vault.write.food',
 *   scopeDescription: 'Save your preferences'
 * });
 */
export function useConsent(): UseConsentReturn {
  const requestConsent = useCallback(
    async (request: ConsentRequest): Promise<boolean> => {
      // This would integrate with a global consent manager
      // For now, we'll use a simple confirm (to be replaced with dialog)
      return window.confirm(
        `${request.agentName} wants to: ${request.scopeDescription}\n\nAllow?`
      );
    },
    []
  );

  return { requestConsent };
}

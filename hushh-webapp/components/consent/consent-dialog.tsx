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

import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/lib/morphy-ux/morphy";
import { Shield, CheckCircle, Clock, Lock } from "lucide-react";
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
  
  const scopeInfoRef = useRef<HTMLDivElement>(null);

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
      <DialogContent
        className="sm:max-w-md"
        aria-busy={isGranting || loading}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          scopeInfoRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (isGranting) event.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-12 w-12 rounded-full bg-linear-to-br from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)] flex items-center justify-center text-2xl shadow-lg">
              {request.agentIcon || "🤫"}
            </div>
            <div>
              <DialogTitle className="text-lg">{request.agentName}</DialogTitle>
              <DialogDescription className="text-sm">
                wants your go-ahead
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Scope Info */}
        <div className="space-y-4 py-4">
          <div
            ref={scopeInfoRef}
            tabIndex={-1}
            className="flex items-start gap-3 p-3 rounded-xl bg-accent-surface dark:bg-accent-surface border border-accent-border dark:border-accent-border focus:outline-none"
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
                className="text-accent-strong"
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
                {request.agentName} will be able to see:
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
            <span>
              Ends on its own in {request.expiresInDays || 7} days. You can undo it anytime.
            </span>
          </div>
        </div>

        {/* Security Note */}
        <div className="text-xs text-muted-foreground bg-gray-50 dark:bg-gray-900 p-3 rounded-lg">
          🔐 Encrypted end-to-end. Only you can open it.
        </div>

        {/* Decline is a first-class, equal-weight, non-punitive choice: "Not now"
            keeps the door open and never reads as an error. Allow carries the
            accent only because it is the affirmative action, not because decline
            is discouraged. */}
        <DialogFooter className="flex gap-2 sm:gap-2">
          <Button
            variant="none"
            onClick={onDeny}
            disabled={isGranting || loading}
            className="flex-1"
          >
            Not now
          </Button>
          <Button
            onClick={handleGrant}
            disabled={isGranting || loading}
            className="flex-1 bg-linear-to-r from-[var(--morphy-primary-start)] to-[var(--morphy-primary-end)] hover:opacity-90"
          >
            {isGranting ? (
              <>
              <HushhLoader variant="compact" className="mr-2 text-white" />
                One moment…
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
import { createRoot } from "react-dom/client";

export interface UseConsentReturn {
  requestConsent: (request: ConsentRequest) => Promise<boolean>;
}

/**
 * Imperatively present the branded consent moment and resolve with the user's
 * decision. This replaces the previous `window.confirm()` stub so every caller
 * gets the designed dialog — the consent-first promise must never degrade to a
 * raw OS prompt. Renders into a detached container so no provider wiring or
 * layout change is required at the call site.
 */
export function showConsentDialog(request: ConsentRequest): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let settled = false;

    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
      // Let the dialog's close animation finish before unmounting.
      setTimeout(() => {
        root.unmount();
        container.remove();
      }, 200);
    };

    function ConsentHost() {
      const [open, setOpen] = useState(true);
      return (
        <ConsentDialog
          open={open}
          request={request}
          onGrant={async () => {
            setOpen(false);
            settle(true);
          }}
          onDeny={() => {
            setOpen(false);
            settle(false);
          }}
        />
      );
    }

    root.render(<ConsentHost />);
  });
}

/**
 * Hook to request consent in components.
 *
 * Usage:
 * const { requestConsent } = useConsent();
 * const granted = await requestConsent({
 *   agentId: 'agent_food_dining',
 *   agentName: 'Food & Dining',
 *   scope: 'attr.food.*',
 *   scopeDescription: 'Save your preferences'
 * });
 */
export function useConsent(): UseConsentReturn {
  const requestConsent = useCallback(
    (request: ConsentRequest): Promise<boolean> => showConsentDialog(request),
    []
  );

  return { requestConsent };
}

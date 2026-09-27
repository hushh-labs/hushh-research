"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { AuthLegalDialog } from "@/components/onboarding/AuthLegalDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { isAccountDeletionActive } from "@/lib/auth/account-deletion-activity";
import { isPublicRoute } from "@/lib/navigation/routes";
import {
  LegalAcceptanceService,
  resolveLegalAcceptanceRequirement,
  type LegalAcceptanceDocumentId,
  type LegalAcceptanceRequirement,
} from "@/lib/services/legal-acceptance-service";

type PromptRequirement = Exclude<LegalAcceptanceRequirement, "none">;

const PROMPT_COPY: Record<PromptRequirement, { title: string; description: string }> = {
  first_acceptance: {
    title: "Terms and Privacy Policy",
    description:
      "Please review our Terms of Use and Privacy Policy. Tap Agree to confirm you accept them.",
  },
  updated: {
    title: "We updated our Terms and Privacy Policy",
    description:
      "Please review what changed. Tap Agree to confirm you accept the updated versions.",
  },
};

/**
 * Asks a signed-in person to accept the Terms and Privacy Policy when the
 * stored acceptance is missing or behind the served versions. Checked once per
 * account per app session; "Not now" asks again next session. A failed check
 * never blocks the app.
 */
export function LegalAcceptanceGate() {
  const { user, loading } = useAuth();
  const pathname = usePathname() ?? "";
  const checkedUserRef = useRef<string | null>(null);
  const [requirement, setRequirement] = useState<PromptRequirement | null>(null);
  const [readingDoc, setReadingDoc] = useState<LegalAcceptanceDocumentId | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const userId = user?.uid ?? null;
  const eligible =
    !loading && Boolean(userId) && !isPublicRoute(pathname) && !isAccountDeletionActive(userId);

  useEffect(() => {
    if (!userId) {
      checkedUserRef.current = null;
      setRequirement(null);
      setReadingDoc(null);
    }
  }, [userId]);

  const userRef = useRef(user);
  userRef.current = user;

  useEffect(() => {
    const checkedUser = userRef.current;
    if (!eligible || !checkedUser || checkedUserRef.current === checkedUser.uid) return;
    checkedUserRef.current = checkedUser.uid;
    let cancelled = false;
    let settled = false;
    void (async () => {
      try {
        await LegalAcceptanceService.waitForSignInRecord(checkedUser.uid);
        const state = await LegalAcceptanceService.fetchState(checkedUser);
        const next = resolveLegalAcceptanceRequirement(state);
        if (!cancelled && next !== "none") setRequirement(next);
      } catch {
        // Unreachable backend or expired session: ask again next session.
      } finally {
        settled = true;
      }
    })();
    return () => {
      cancelled = true;
      // Interrupted before an answer (left for a public route, signed out):
      // allow a fresh check instead of silently skipping this session.
      if (!settled) checkedUserRef.current = null;
    };
  }, [eligible, userId]);

  if (!requirement || !user) return null;

  const copy = PROMPT_COPY[requirement];

  const handleAgree = async () => {
    setSaving(true);
    setSaveFailed(false);
    try {
      await LegalAcceptanceService.recordAcceptance(user);
      setRequirement(null);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog
        open={readingDoc === null}
        onOpenChange={(open) => {
          if (!open && !saving) setRequirement(null);
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-sm">
          <DialogHeader className="text-left">
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-4 text-sm">
            <button
              type="button"
              className="font-semibold text-[color:var(--app-accent)] hover:opacity-75"
              onClick={() => setReadingDoc("terms")}
            >
              Terms of Use
            </button>
            <button
              type="button"
              className="font-semibold text-[color:var(--app-accent)] hover:opacity-75"
              onClick={() => setReadingDoc("privacy")}
            >
              Privacy Policy
            </button>
          </div>
          {saveFailed ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn’t save. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => setRequirement(null)}
            >
              Not now
            </Button>
            <Button type="button" disabled={saving} onClick={() => void handleAgree()}>
              {saving ? "Saving…" : "Agree"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AuthLegalDialog
        docType={readingDoc}
        onOpenChange={(open) => {
          if (!open) setReadingDoc(null);
        }}
      />
    </>
  );
}

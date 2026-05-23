"use client";

import { type KaiLegalDocumentType } from "@/lib/legal/kai-legal-content";

interface AuthLegalFooterProps {
  compact?: boolean;
  onOpenLegalDoc: (docType: KaiLegalDocumentType) => void;
}

export function AuthLegalFooter({
  compact = false,
  onOpenLegalDoc,
}: AuthLegalFooterProps) {
  return (
    <footer
      aria-label="Authentication legal disclosures"
      className={compact ? "flex-none pt-4" : "flex-none pt-3"}
    >
      <p className="mx-auto max-w-[18.75rem] text-center text-[11px] leading-normal text-muted-foreground/80">
        By continuing, you agree to Kai&apos;s{" "}
        <button
          type="button"
          onClick={() => onOpenLegalDoc("terms")}
          className="font-semibold text-foreground underline underline-offset-2 transition-opacity hover:opacity-70"
        >
          Terms
        </button>{" "}
        and{" "}
        <button
          type="button"
          onClick={() => onOpenLegalDoc("privacy")}
          className="font-semibold text-foreground underline underline-offset-2 transition-opacity hover:opacity-70"
        >
          Privacy Policy
        </button>
        .
      </p>
    </footer>
  );
}

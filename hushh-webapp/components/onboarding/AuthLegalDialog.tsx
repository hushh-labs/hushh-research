"use client";

import Link from "next/link";

import { X } from "@/components/icons";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  LegalDocumentBody,
  LegalDocumentMeta,
} from "@/components/legal/legal-document-body";
import {
  LEGAL_DOCUMENTS,
  type LegalDocument,
  type LegalDocumentType,
} from "@/lib/legal/legal-documents";

type AuthLegalDialogProps = {
  docType: LegalDocumentType | null;
  onOpenChange: (open: boolean) => void;
  closeControlId?: string;
};

// The sheet renders the full document inline from LEGAL_DOCUMENTS, the same
// source the public /privacy and /terms pages serve, and links to that page.
function FullPageLink({ doc }: { doc: LegalDocument }) {
  return (
    <Link
      href={doc.route}
      className="type-caption inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-muted-foreground transition-colors hover:text-foreground"
    >
      Open full page
    </Link>
  );
}

function LegalDocBody({ doc }: { doc: LegalDocument }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <FullPageLink doc={doc} />
      </div>
      <div className="mt-1">
        <p className="type-footnote text-muted-foreground">
          <LegalDocumentMeta doc={doc} />
        </p>
        <p className="mt-2 text-sm leading-6 text-foreground/90">
          {doc.summary}
        </p>
        <div className="mt-5">
          <LegalDocumentBody doc={doc} compact />
        </div>
      </div>
    </>
  );
}

export function AuthLegalDialog({
  docType,
  onOpenChange,
  closeControlId,
}: AuthLegalDialogProps) {
  const isMobile = useIsMobile();
  const isOpen = docType !== null;
  const doc = docType ? LEGAL_DOCUMENTS[docType] : null;

  if (!doc) {
    // Keep both roots mounted-but-closed so open/close transitions never
    // remount the dialog/drawer primitive mid-animation.
    return (
      <>
        <Dialog open={false} onOpenChange={onOpenChange} modal={false} />
        <Sheet open={false} onOpenChange={onOpenChange} />
      </>
    );
  }

  if (isMobile) {
    return (
      <Sheet modal open={isOpen} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[82dvh] gap-0 overflow-hidden rounded-t-[var(--app-card-radius-feature)] border-t border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-0"
        >
          <div className="border-b border-border/50 px-5 pb-3">
            <div className="flex items-center justify-between gap-3">
              <SheetTitle className="text-left">{doc.title}</SheetTitle>
              <SheetClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-full"
                  aria-label="Close legal document"
                  data-voice-control-id={closeControlId}
                >
                  <X className="h-4 w-4" />
                </Button>
              </SheetClose>
            </div>
          </div>
          <div className="overflow-y-auto overscroll-contain px-5 pb-[calc(var(--app-safe-area-bottom-effective,env(safe-area-inset-bottom,0px))+2rem)] pt-5">
            <LegalDocBody doc={doc} />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange} modal={false}>
      <DialogContent
        showCloseButton={false}
        className="max-w-[min(40rem,calc(100%-1.5rem))] max-h-[calc(100dvh-1.5rem)] gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="sticky top-0 z-20 border-b border-border bg-[color:var(--app-card-surface-default-solid)] px-5 py-4 text-left">
          <div className="flex items-center gap-3 pr-11">
            <DialogTitle>{doc.title}</DialogTitle>
            <FullPageLink doc={doc} />
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-3 top-3 h-9 w-9 rounded-full"
                aria-label="Close legal document"
                data-voice-control-id={closeControlId}
              >
                <X className="h-4 w-4" />
              </Button>
            </DialogClose>
          </div>
        </DialogHeader>
        <div className="max-h-[min(72dvh,44rem)] overflow-y-auto px-5 pt-5 pb-24">
          <p className="type-footnote text-muted-foreground">
            <LegalDocumentMeta doc={doc} />
          </p>
          <p className="mt-2 text-sm leading-6 text-foreground/90">
            {doc.summary}
          </p>
          <div className="mt-5">
            <LegalDocumentBody doc={doc} compact />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

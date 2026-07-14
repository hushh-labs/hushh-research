"use client";

import { ExternalLink, X } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  KAI_LEGAL_DOCUMENTS,
  type KaiLegalDocumentType,
} from "@/lib/legal/kai-legal-content";

type AuthLegalDialogProps = {
  docType: KaiLegalDocumentType | null;
  onOpenChange: (open: boolean) => void;
  closeControlId?: string;
};

// External canonical sources on hushh.ai. We render the same content inline
// (formatted from KAI_LEGAL_DOCUMENTS) and offer a lean link to the live site,
// no embedded browser preview / iframe.
const LEGAL_SOURCE_URL: Record<KaiLegalDocumentType, string> = {
  privacy: "https://www.hushh.ai/privacy",
  terms: "https://www.hushh.ai/terms",
};

function LegalDocBody({
  doc,
  sourceUrl,
}: {
  doc: (typeof KAI_LEGAL_DOCUMENTS)[KaiLegalDocumentType];
  sourceUrl: string;
}) {
  return (
    <>
      <div className="flex items-center gap-3">
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="type-caption inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          View on hushh.ai
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      <div className="mt-1">
        <p className="type-footnote text-muted-foreground">
          Last updated {doc.updatedAt}
        </p>
        <p className="mt-2 text-sm leading-6 text-foreground/90">
          {doc.summary}
        </p>
        <div className="mt-5 space-y-5">
          {doc.sections.map((section) => (
            <section key={section.title} className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">
                {section.title}
              </h3>
              <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">
                {section.points.map((point, index) => (
                  <li key={index}>{point}</li>
                ))}
              </ul>
            </section>
          ))}
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
  const doc = docType ? KAI_LEGAL_DOCUMENTS[docType] : null;
  const sourceUrl = docType ? LEGAL_SOURCE_URL[docType] : null;

  if (!doc || !sourceUrl) {
    // Keep both roots mounted-but-closed so open/close transitions never
    // remount the dialog/drawer primitive mid-animation.
    return (
      <>
        <Dialog open={false} onOpenChange={onOpenChange} modal={false} />
        <Drawer open={false} onOpenChange={onOpenChange} />
      </>
    );
  }

  if (isMobile) {
    return (
      <Drawer open={isOpen} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[85dvh] rounded-t-[28px] border-t border-border/80 bg-background/98">
          <DrawerHeader className="border-b border-border/80 bg-background/96 px-5 py-4 text-left backdrop-blur-xl">
            <div className="flex items-center justify-between gap-3">
              <DrawerTitle>{doc.title}</DrawerTitle>
              <DrawerClose asChild>
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
              </DrawerClose>
            </div>
          </DrawerHeader>
          <div className="max-h-[calc(85dvh-4.5rem)] overflow-y-auto px-5 pb-[calc(var(--app-safe-area-bottom-effective,env(safe-area-inset-bottom,0px))+2rem)] pt-5">
            <LegalDocBody doc={doc} sourceUrl={sourceUrl} />
          </div>
        </DrawerContent>
      </Drawer>
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
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="type-caption inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              View on hushh.ai
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
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
            Last updated {doc.updatedAt}
          </p>
          <p className="mt-2 text-sm leading-6 text-foreground/90">
            {doc.summary}
          </p>
          <div className="mt-5 space-y-5">
            {doc.sections.map((section) => (
              <section key={section.title} className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">
                  {section.title}
                </h3>
                <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">
                  {section.points.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

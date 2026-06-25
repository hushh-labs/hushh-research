"use client";

import { ExternalLink, X } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  KAI_LEGAL_DOCUMENTS,
  type KaiLegalDocumentType,
} from "@/lib/legal/kai-legal-content";

type AuthLegalDialogProps = {
  docType: KaiLegalDocumentType | null;
  onOpenChange: (open: boolean) => void;
};

// External canonical sources on hushh.ai. We render the same content inline
// (formatted from KAI_LEGAL_DOCUMENTS) and offer a lean link to the live site,
// no embedded browser preview / iframe.
const LEGAL_SOURCE_URL: Record<KaiLegalDocumentType, string> = {
  privacy: "https://www.hushh.ai/privacy",
  terms: "https://www.hushh.ai/terms",
};

export function AuthLegalDialog({ docType, onOpenChange }: AuthLegalDialogProps) {
  const isOpen = docType !== null;
  const doc = docType ? KAI_LEGAL_DOCUMENTS[docType] : null;
  const sourceUrl = docType ? LEGAL_SOURCE_URL[docType] : null;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange} modal>
      <DialogContent
        showCloseButton={false}
        className="max-w-[min(40rem,calc(100%-1.5rem))] max-h-[calc(100dvh-1.5rem)] gap-0 overflow-hidden p-0"
      >
        {doc && sourceUrl ? (
          <>
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
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </DialogClose>
              </div>
            </DialogHeader>
            <div className="max-h-[min(72dvh,44rem)] overflow-y-auto px-5 py-5">
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
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

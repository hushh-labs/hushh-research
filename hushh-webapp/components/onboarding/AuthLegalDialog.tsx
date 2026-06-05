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
import { type KaiLegalDocumentType } from "@/lib/legal/kai-legal-content";

type AuthLegalDialogProps = {
  docType: KaiLegalDocumentType | null;
  onOpenChange: (open: boolean) => void;
};

const LEGAL_DOCS: Record<
  KaiLegalDocumentType,
  { title: string; url: string; embedUrl: string }
> = {
  privacy: {
    title: "Privacy Policy",
    url: "https://www.hushh.ai/privacy",
    embedUrl: "/api/legal/privacy",
  },
  terms: {
    title: "Terms",
    url: "https://www.hushh.ai/terms",
    embedUrl: "/api/legal/terms",
  },
};

export function AuthLegalDialog({ docType, onOpenChange }: AuthLegalDialogProps) {
  const isOpen = docType !== null;
  const content = docType ? LEGAL_DOCS[docType] : null;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange} modal>
      <DialogContent
        showCloseButton={false}
        className="max-w-[min(54rem,calc(100%-1.5rem))] max-h-[calc(100dvh-1.5rem)] gap-0 overflow-hidden p-0"
      >
        {content ? (
          <>
            <DialogHeader className="sticky top-0 z-20 border-b border-border bg-[color:var(--app-card-surface-default-solid)] px-5 py-4 text-left">
              <div className="flex items-center gap-3 pr-11">
                <DialogTitle>{content.title}</DialogTitle>
                <a
                  href={content.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Open in browser
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
            <iframe
              title={content.title}
              src={content.embedUrl}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              className="h-[min(72dvh,44rem)] w-full border-0 bg-background"
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

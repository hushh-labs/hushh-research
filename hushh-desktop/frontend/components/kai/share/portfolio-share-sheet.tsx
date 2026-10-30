"use client";

import { useState } from "react";
import {
  Image as ImageIcon,
  Link as LinkIcon,
  FileText,
  Loader2,
  Share2,
  type LucideIcon,
} from "lucide-react";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  exportPortfolioPdf,
  requestPortfolioShareLink,
  sharePortfolioLink,
  sharePortfolioSnapshot,
  type ShareDelivery,
} from "@/lib/portfolio-share/client";
import type { PortfolioSharePayload } from "@/lib/portfolio-share/contract";
import { cn } from "@/lib/utils";

interface PortfolioShareSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payload: PortfolioSharePayload;
}

type ShareAction = "snapshot" | "link" | "pdf";

function isShareCancelError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  const message = String((error as Error)?.message || "").toLowerCase();
  return message.includes("cancel") || message.includes("cancelled") || message.includes("canceled");
}

function getActionResultMessage(action: ShareAction, result: ShareDelivery): string {
  if (action === "snapshot") {
    if (result === "download") return "Snapshot downloaded.";
    return "Snapshot ready to share.";
  }

  if (action === "pdf") {
    if (result === "download") return "PDF exported to downloads.";
    return "Portfolio report ready to share.";
  }

  if (result === "copied") return "Share link copied to clipboard.";
  return "Share link is ready.";
}

function ActionRow(props: {
  title: string;
  description: string;
  icon: LucideIcon;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;

  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-busy={props.busy}
      aria-label={`${props.title}: ${props.description}`}
      className={cn(
        "w-full rounded-2xl border border-border/70 bg-background/65 p-4 text-left transition",
        "hover:bg-background/85 disabled:cursor-not-allowed disabled:opacity-60"
      )}
    >
      <div className="flex items-start gap-3">
        <div aria-hidden="true" className="mt-0.5 rounded-xl border border-border/60 bg-background/80 p-2 text-foreground">
          {props.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{props.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{props.description}</p>
        </div>
      </div>
    </button>
  );
}

export function PortfolioShareSheet({ open, onOpenChange, payload }: PortfolioShareSheetProps) {
  const [activeAction, setActiveAction] = useState<ShareAction | null>(null);

  async function runAction(action: ShareAction, task: () => Promise<ShareDelivery>) {
    if (activeAction) return;

    setActiveAction(action);
    try {
      const result = await task();
      toast.success(getActionResultMessage(action, result));
      onOpenChange(false);
    } catch (error) {
      if (isShareCancelError(error)) {
        return;
      }
      console.error(`[PortfolioShareSheet] ${action} failed:`, error);
      const fallback =
        action === "snapshot"
          ? "Could not share snapshot."
          : action === "link"
            ? "Could not create share link."
            : "Could not export portfolio PDF.";
      toast.error(fallback);
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-3xl border-border/70 bg-background/95 p-0 sm:mx-auto sm:max-w-md"
      >
        <div className="px-5 pb-[calc(1.25rem+var(--app-safe-area-bottom-effective))] pt-4">
          <SheetHeader className="px-0 pb-3 text-left">
            <div className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-background/70">
              <Share2 className="h-4 w-4" />
            </div>
            <SheetTitle className="mt-2">Share Portfolio</SheetTitle>
            <SheetDescription>
              Share a read-only summary. Personal account identifiers are excluded.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-2">
            <ActionRow
              title="Share Snapshot"
              description="Generate a PNG image of value, change, holdings, and allocation mix."
              icon={ImageIcon}
              busy={activeAction === "snapshot"}
              disabled={Boolean(activeAction)}
              onClick={() => runAction("snapshot", () => sharePortfolioSnapshot(payload))}
            />

            <ActionRow
              title="Share Web Link"
              description="Create a public read-only URL with value, holdings, sector allocation, and performance."
              icon={LinkIcon}
              busy={activeAction === "link"}
              disabled={Boolean(activeAction)}
              onClick={() =>
                runAction("link", async () => {
                  const { url } = await requestPortfolioShareLink(payload);
                  return sharePortfolioLink(url);
                })
              }
            />

            <ActionRow
              title="Export PDF"
              description="Export a formatted report with holdings, allocation, and performance graphs."
              icon={FileText}
              busy={activeAction === "pdf"}
              disabled={Boolean(activeAction)}
              onClick={() => runAction("pdf", () => exportPortfolioPdf(payload))}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

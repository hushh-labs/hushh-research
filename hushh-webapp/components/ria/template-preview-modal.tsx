"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";

// The RIA picks CSV template. Mirrors public/templates/ria-picks-template.csv;
// kept inline so the download is a client-side Blob (a bare `<a download>` on
// the raw static path does not save inside the iOS WKWebView — it navigates to
// a tiny unstyled raw-CSV page, which is the bug this modal replaces).
const TEMPLATE_FILENAME = "ria-picks-template.csv";
const TEMPLATE_CSV = `ticker,company_name,sector,tier,tier_rank,conviction_weight,recommendation_bias,investment_thesis,fcf_billions
MSFT,Microsoft,Technology,Core,1,0.92,Accumulate,Durable cloud and productivity cash flows with AI optionality,74.1
LLY,Eli Lilly,Healthcare,Core,2,0.88,Accumulate,Obesity and diabetes pipeline strength with strong pricing power,12.7
SPGI,S&P Global,Financials,Satellite,3,0.76,Monitor,High-quality index and ratings franchise with recurring data revenues,5.4
`;

function parseCsv(csv: string): { headers: string[]; rows: string[][] } {
  // Simple split-based parse: the template is a fixed, comma-only sample with
  // no embedded commas/quotes, so a full RFC-4180 parser is unnecessary here.
  const lines = csv.trim().split(/\r?\n/);
  const headers = (lines[0] ?? "").split(",");
  const rows = lines.slice(1).map((line) => line.split(","));
  return { headers, rows };
}

function triggerCsvDownload(): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([TEMPLATE_CSV], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = TEMPLATE_FILENAME;
  // Appending to the DOM before click is required for the download to fire in
  // some WebKit builds; revoke on the next tick so the download can start.
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Styled dark-theme preview of the RIA picks CSV template with a real
 * client-side download. Replaces the raw `<a href="/templates/....csv" download>`
 * that opened an unstyled white raw-CSV page inside the iOS webview.
 */
export function TemplatePreviewModal({
  triggerLabel = "Template",
  triggerClassName,
  triggerVoiceControlId,
}: {
  triggerLabel?: string;
  triggerClassName?: string;
  triggerVoiceControlId?: string;
}) {
  const [open, setOpen] = useState(false);
  const { headers, rows } = useMemo(() => parseCsv(TEMPLATE_CSV), []);

  return (
    <Dialog open={open} onOpenChange={setOpen} modal>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="none"
          effect="fade"
          size="sm"
          className={cn(triggerClassName)}
          data-voice-control-id={triggerVoiceControlId}
        >
          <Download className="mr-2 h-4 w-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[min(56rem,calc(100%-1.5rem))] gap-0 p-0">
        <DialogHeader className="border-b border-[color:var(--app-card-border-standard)] px-5 py-4 text-left">
          <DialogTitle className="text-base font-semibold tracking-tight">
            CSV Template Preview
          </DialogTitle>
          <DialogDescription className="text-sm leading-6 text-muted-foreground">
            Match these column headers and formats, then upload your filled file
            to replace the top picks list.
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-4 sm:px-5">
          <div className="overflow-x-auto rounded-lg border border-border [-webkit-overflow-scrolling:touch]">
            <table className="w-full min-w-[44rem] border-collapse text-left text-xs">
              <thead>
                <tr>
                  {headers.map((header) => (
                    <th
                      key={header}
                      className="whitespace-nowrap border-b border-border bg-muted/50 p-2 font-semibold text-muted-foreground"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="odd:bg-muted/20">
                    {row.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        className="whitespace-nowrap border-b border-border/60 p-2 text-foreground"
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Scroll horizontally to see all {headers.length} columns.
          </p>
        </div>

        <div className="border-t border-[color:var(--app-card-border-standard)] px-5 py-4">
          <Button
            type="button"
            variant="blue-gradient"
            effect="fill"
            className="w-full justify-center"
            onClick={triggerCsvDownload}
          >
            <Download className="mr-2 h-4 w-4" />
            Download CSV Template (.csv)
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

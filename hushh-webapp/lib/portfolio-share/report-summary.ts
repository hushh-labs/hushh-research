import type { jsPDF } from "jspdf";

import type { PortfolioSharePayload } from "@/lib/portfolio-share/contract";
import { formatCurrency, formatSignedCurrency, formatSignedPercent } from "@/lib/portfolio-share/format";

export interface PortfolioReportContext {
  source: string;
  period: string;
  change: number | null;
  changePct: number | null;
}

export function drawPortfolioReportSummary(
  doc: jsPDF,
  payload: PortfolioSharePayload,
  left: number,
  right: number,
  context?: PortfolioReportContext
): void {
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFillColor(248, 250, 252);
  doc.rect(0, 0, pageWidth, doc.internal.pageSize.getHeight(), "F");

  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(21);
  doc.text("Portfolio Report", left, 56);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(`Generated ${new Date(payload.generatedAt).toLocaleString("en-US")}`, left, 74);

  doc.setFont("helvetica", "bold");
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(13);
  if (context) {
    doc.setFontSize(9);
    doc.text(doc.splitTextToSize(`${context.source} · ${context.period}`, right - left), left, 90);
    doc.setFontSize(13);
  }
  doc.text("Portfolio Value", left, 118);
  doc.setFontSize(28);
  doc.text(formatCurrency(payload.portfolioValue), left, 148);
  doc.setFontSize(12);
  const change = context ? context.change : payload.dailyChangeValue;
  const changePct = context ? context.changePct : payload.dailyChangePct;
  doc.setTextColor(change === null ? "#64748b" : change >= 0 ? "#059669" : "#dc2626");
  doc.text(change === null ? "Period balance change unavailable" : `${formatSignedCurrency(change)}${changePct === null ? "" : ` (${formatSignedPercent(changePct)})`}`, left, 168);
  if (context && change !== null) {
    doc.setFontSize(9);
    doc.text("Period balance change includes cash flows.", left, 182);
  }
}

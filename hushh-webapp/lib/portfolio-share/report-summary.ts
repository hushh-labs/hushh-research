import type { jsPDF } from "jspdf";

import type { Holding } from "@/components/kai/types/portfolio";
import type { PortfolioSharePayload } from "@/lib/portfolio-share/contract";
import { formatCurrency, formatSignedCurrency, formatSignedPercent } from "@/lib/portfolio-share/format";

export interface PortfolioReportContext {
  source: string;
  period: string;
  change: number | null;
  changePct: number | null;
  positions?: readonly Holding[];
}

export function drawPortfolioReportHoldings(doc: jsPDF, positions: readonly Holding[], left: number, right: number): void {
  const bottom = doc.internal.pageSize.getHeight() - 44;
  let y = bottom;
  for (const position of positions) {
    if (y + 20 > bottom) {
      doc.addPage();
      doc.setTextColor(15, 23, 42);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.text(`Holdings (${positions.length})`, left, 54);
      doc.setFontSize(9);
      doc.text("Security", left, 78);
      doc.text("Market value", right, 78, { align: "right" });
      y = 100;
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const symbol = position.symbol;
    const label = [symbol, position.name === symbol ? "" : position.name].filter(Boolean).join("  ");
    const currencyCode = position.currency || position.iso_currency_code || "";
    const currency = /^[A-Z]{3}$/.test(currencyCode) ? currencyCode : "USD";
    const value = new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "code" }).format(position.market_value);
    doc.text(doc.splitTextToSize(label, right - left - 126)[0] ?? "", left, y);
    doc.text(value, right, y, { align: "right" });
    y += 18;
  }
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

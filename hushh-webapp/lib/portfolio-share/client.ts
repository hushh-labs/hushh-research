import { Capacitor } from "@capacitor/core";

import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import { copyToClipboard } from "@/lib/utils/clipboard";
import {
  blobToBase64String,
  downloadBlobFile,
} from "@/lib/utils/native-download";
import { ApiService } from "@/lib/services/api-service";
import {
  sanitizePortfolioSharePayload,
  type PortfolioSharePayload,
  type PortfolioShareAllocationItem,
} from "@/lib/portfolio-share/contract";

export type ShareDelivery = "native-share" | "web-share" | "download" | "copied";

const SNAPSHOT_WIDTH = 1080;
const SNAPSHOT_HEIGHT = 1320;
const SNAPSHOT_COLORS = [
  "#2563eb",
  "#0ea5e9",
  "#14b8a6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
];

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatSignedCurrency(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatCurrency(Math.abs(value))}`;
}

function formatSignedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatDateLabel(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value.slice(0, 14);
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fillStyle: string
) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));

  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();

  ctx.fillStyle = fillStyle;
  ctx.fill();
}

function isShareAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  const message = String((error as Error)?.message || "").toLowerCase();
  return message.includes("cancel") || message.includes("canceled") || message.includes("cancelled");
}

async function writeBlobToNativeFile(blob: Blob, fileName: string): Promise<string> {
  const { Filesystem, Directory } = (await import("@capacitor/filesystem")) as typeof import("@capacitor/filesystem");

  const base64 = await blobToBase64String(blob);
  const path = `portfolio-share/${Date.now()}-${fileName}`;

  const writeResult = await Filesystem.writeFile({
    path,
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  });

  return writeResult.uri;
}

async function deliverBlob(
  blob: Blob,
  fileName: string,
  mimeType: string,
  shareText: string,
  title: string
): Promise<ShareDelivery> {
  if (Capacitor.isNativePlatform()) {
    const { Share } = (await import("@capacitor/share")) as typeof import("@capacitor/share");
    const uri = await writeBlobToNativeFile(blob, fileName);
    await Share.share({
      title,
      text: shareText,
      files: [uri],
      dialogTitle: title,
    });
    return "native-share";
  }

  const file = new File([blob], fileName, { type: mimeType });

  if (
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] })
  ) {
    try {
      await navigator.share({
        title,
        text: shareText,
        files: [file],
      });
      return "web-share";
    } catch (error) {
      if (isShareAbortError(error)) {
        throw error;
      }
    }
  }

  const downloaded = await downloadBlobFile(blob, fileName, mimeType);
  if (downloaded) {
    return "download";
  }

  throw new Error("Download is not supported on this device.");
}

function prepareAllocationRows(
  allocation: PortfolioShareAllocationItem[],
  fallbackTotal: number
): PortfolioShareAllocationItem[] {
  return allocation.map((row) => ({
    label: row.label,
    value: row.value,
    pct: row.pct > 0 ? row.pct : fallbackTotal > 0 ? (row.value / fallbackTotal) * 100 : 0,
  }));
}

function getHexColor(index: number): string {
  return SNAPSHOT_COLORS[index % SNAPSHOT_COLORS.length] || "#2563eb";
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace("#", "");
  const chunks =
    normalized.length === 3
      ? normalized.split("").map((chunk) => `${chunk}${chunk}`)
      : [normalized.slice(0, 2), normalized.slice(2, 4), normalized.slice(4, 6)];

  const r = Number.parseInt(chunks[0] || "25", 16);
  const g = Number.parseInt(chunks[1] || "99", 16);
  const b = Number.parseInt(chunks[2] || "235", 16);

  return {
    r: Number.isFinite(r) ? r : 37,
    g: Number.isFinite(g) ? g : 99,
    b: Number.isFinite(b) ? b : 235,
  };
}

export function buildPortfolioSharePayloadFromDashboardModel(
  model: DashboardViewModel
): PortfolioSharePayload {
  const totalValue = Math.max(0, Number(model.hero.totalValue || 0));

  const topHoldings = model.canonicalModel.positions
    .filter((position) => Number(position.marketValue || 0) > 0)
    .sort((a, b) => Number(b.marketValue || 0) - Number(a.marketValue || 0))
    .slice(0, 8)
    .map((position) => {
      const value = Number(position.marketValue || 0);
      return {
        symbol: String(position.displaySymbol || position.rawSymbol || "HOLD").trim(),
        name: String(position.name || position.displaySymbol || "Holding").trim(),
        value,
        weightPct: totalValue > 0 ? (value / totalValue) * 100 : 0,
        changeValue: Number(position.gainLoss || 0),
        changePct: Number(position.gainLossPct || 0),
      };
    });

  const allocationMix = model.allocation.slice(0, 8).map((row) => ({
    label: row.name,
    value: Number(row.value || 0),
    pct: totalValue > 0 ? (Number(row.value || 0) / totalValue) * 100 : 0,
  }));

  const sectorAllocation =
    model.equity_sector_allocation.length > 0
      ? model.equity_sector_allocation.slice(0, 10).map((row) => ({
          label: row.sector,
          value: Number(row.value || 0),
          pct: Number(row.pct || 0),
        }))
      : model.non_equity_allocation.slice(0, 10).map((row) => ({
          label: row.bucket,
          value: Number(row.value || 0),
          pct: Number(row.pct || 0),
        }));

  const performanceHistory = model.history.slice(-24);
  const performance =
    performanceHistory.length > 0
      ? performanceHistory.map((point) => ({
          label: point.date,
          value: Number(point.value || 0),
        }))
      : [
          { label: "Start", value: Number(model.hero.beginningValue || 0) },
          { label: "Current", value: Number(model.hero.endingValue || model.hero.totalValue || 0) },
        ].filter((point) => point.value > 0);

  return sanitizePortfolioSharePayload({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    portfolioValue: totalValue,
    dailyChangeValue: Number(model.hero.netChange || 0),
    dailyChangePct: Number(model.hero.changePct || 0),
    topHoldings,
    allocationMix,
    sectorAllocation,
    performance,
  });
}

export async function generatePortfolioSnapshotPng(payloadInput: unknown): Promise<Blob> {
  const payload = sanitizePortfolioSharePayload(payloadInput);
  const canvas = document.createElement("canvas");
  canvas.width = SNAPSHOT_WIDTH;
  canvas.height = SNAPSHOT_HEIGHT;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas is unavailable in this environment");
  }

  const gradient = ctx.createLinearGradient(0, 0, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);
  gradient.addColorStop(0, "#020617");
  gradient.addColorStop(1, "#0f172a");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);

  drawRoundedRect(ctx, 48, 46, SNAPSHOT_WIDTH - 96, 250, 30, "rgba(15, 23, 42, 0.82)");

  ctx.fillStyle = "#94a3b8";
  ctx.font = "600 30px Manrope, system-ui, sans-serif";
  ctx.fillText("PORTFOLIO SNAPSHOT", 84, 98);

  ctx.fillStyle = "#e2e8f0";
  ctx.font = "700 72px Manrope, system-ui, sans-serif";
  ctx.fillText(formatCurrency(payload.portfolioValue), 84, 178);

  ctx.font = "600 40px Manrope, system-ui, sans-serif";
  ctx.fillStyle = payload.dailyChangeValue >= 0 ? "#10b981" : "#fb7185";
  ctx.fillText(
    `${formatSignedCurrency(payload.dailyChangeValue)} (${formatSignedPercent(payload.dailyChangePct)})`,
    84,
    236
  );

  drawRoundedRect(ctx, 48, 326, SNAPSHOT_WIDTH - 96, 430, 26, "rgba(15, 23, 42, 0.82)");
  ctx.fillStyle = "#cbd5e1";
  ctx.font = "600 34px Manrope, system-ui, sans-serif";
  ctx.fillText("Top Holdings", 84, 380);

  const holdings = payload.topHoldings.slice(0, 5);
  const holdingsMaxValue = Math.max(...holdings.map((holding) => holding.value), 1);

  holdings.forEach((holding, index) => {
    const top = 430 + index * 64;
    const barWidth = Math.max(40, (holding.value / holdingsMaxValue) * 520);

    ctx.fillStyle = "#e2e8f0";
    ctx.font = "700 26px Manrope, system-ui, sans-serif";
    ctx.fillText(holding.symbol, 84, top);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "500 20px Manrope, system-ui, sans-serif";
    ctx.fillText(holding.name.slice(0, 36), 84, top + 26);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "600 22px Manrope, system-ui, sans-serif";
    ctx.fillText(formatCurrency(holding.value), 710, top);

    ctx.fillStyle = "rgba(100, 116, 139, 0.25)";
    drawRoundedRect(ctx, 84, top + 34, 540, 12, 6, "rgba(100, 116, 139, 0.25)");
    drawRoundedRect(ctx, 84, top + 34, barWidth, 12, 6, getHexColor(index));
  });

  drawRoundedRect(ctx, 48, 780, SNAPSHOT_WIDTH - 96, 490, 26, "rgba(15, 23, 42, 0.82)");
  ctx.fillStyle = "#cbd5e1";
  ctx.font = "600 34px Manrope, system-ui, sans-serif";
  ctx.fillText("Allocation Mix", 84, 834);

  const allocation = prepareAllocationRows(payload.allocationMix.slice(0, 6), payload.portfolioValue);

  allocation.forEach((entry, index) => {
    const rowY = 886 + index * 62;
    const width = Math.max(24, Math.min(610, entry.pct * 6.1));
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "600 24px Manrope, system-ui, sans-serif";
    ctx.fillText(entry.label, 84, rowY);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "500 20px Manrope, system-ui, sans-serif";
    ctx.fillText(`${entry.pct.toFixed(1)}%`, 390, rowY);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "500 20px Manrope, system-ui, sans-serif";
    ctx.fillText(formatCurrency(entry.value), 700, rowY);

    drawRoundedRect(ctx, 84, rowY + 14, 620, 12, 6, "rgba(100, 116, 139, 0.25)");
    drawRoundedRect(ctx, 84, rowY + 14, width, 12, 6, getHexColor(index));
  });

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Unable to render snapshot image"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

export async function generatePortfolioReportPdf(payloadInput: unknown): Promise<Blob> {
  const payload = sanitizePortfolioSharePayload(payloadInput);
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  const pageWidth = doc.internal.pageSize.getWidth();
  const left = 44;
  const right = pageWidth - 44;

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
  doc.text("Portfolio Value", left, 108);
  doc.setFontSize(28);
  doc.text(formatCurrency(payload.portfolioValue), left, 138);
  doc.setFontSize(12);
  doc.setTextColor(payload.dailyChangeValue >= 0 ? "#059669" : "#dc2626");
  doc.text(
    `${formatSignedCurrency(payload.dailyChangeValue)} (${formatSignedPercent(payload.dailyChangePct)})`,
    left,
    160
  );

  let y = 198;
  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Holdings Summary", left, y);

  y += 18;
  const holdings = payload.topHoldings.slice(0, 8);
  if (holdings.length === 0) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(71, 85, 105);
    doc.text("No holdings data available.", left, y + 4);
    y += 18;
  } else {
    holdings.forEach((holding) => {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(15, 23, 42);
      doc.text(holding.symbol, left, y);

      doc.setFont("helvetica", "normal");
      doc.setTextColor(71, 85, 105);
      doc.text(holding.name.slice(0, 42), left + 52, y);

      doc.setTextColor(15, 23, 42);
      doc.text(`${holding.weightPct.toFixed(1)}%`, right - 110, y, { align: "right" });
      doc.text(formatCurrency(holding.value), right, y, { align: "right" });
      y += 16;
    });
  }

  y += 24;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text("Allocation Charts", left, y);

  y += 20;
  const allocation = prepareAllocationRows(payload.allocationMix.slice(0, 6), payload.portfolioValue);
  allocation.forEach((entry, index) => {
    const color = hexToRgb(getHexColor(index));
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(51, 65, 85);
    doc.text(entry.label, left, y);
    doc.text(`${entry.pct.toFixed(1)}%`, right - 110, y, { align: "right" });
    doc.text(formatCurrency(entry.value), right, y, { align: "right" });

    doc.setFillColor(226, 232, 240);
    doc.roundedRect(left, y + 5, right - left, 7, 3, 3, "F");

    doc.setFillColor(color.r, color.g, color.b);
    doc.roundedRect(left, y + 5, Math.max(10, ((right - left) * entry.pct) / 100), 7, 3, 3, "F");
    y += 20;
  });

  y += 20;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text("Performance Graph", left, y);

  y += 16;
  const chartTop = y;
  const chartHeight = 130;
  const chartLeft = left;
  const chartRight = right;
  const performance = payload.performance.slice(-20);

  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(1);
  doc.line(chartLeft, chartTop + chartHeight, chartRight, chartTop + chartHeight);

  if (performance.length >= 2) {
    const values = performance.map((point) => point.value);
    const minValue = Math.min(...values, 0);
    const maxValue = Math.max(...values, 1);
    const range = Math.max(1, maxValue - minValue);
    const stepX = (chartRight - chartLeft) / (performance.length - 1);

    doc.setDrawColor(37, 99, 235);
    doc.setLineWidth(2);

    performance.forEach((point, index) => {
      if (index === 0) return;
      const prev = performance[index - 1];
      if (!prev) return;

      const x1 = chartLeft + stepX * (index - 1);
      const y1 = chartTop + chartHeight - ((prev.value - minValue) / range) * chartHeight;
      const x2 = chartLeft + stepX * index;
      const y2 = chartTop + chartHeight - ((point.value - minValue) / range) * chartHeight;
      doc.line(x1, y1, x2, y2);
    });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    const firstLabel = formatDateLabel(performance[0]?.label || "Start");
    const lastLabel = formatDateLabel(performance[performance.length - 1]?.label || "Now");
    doc.text(firstLabel, chartLeft, chartTop + chartHeight + 14);
    doc.text(lastLabel, chartRight, chartTop + chartHeight + 14, { align: "right" });
  } else {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(71, 85, 105);
    doc.text("Not enough performance points to render graph.", chartLeft, chartTop + 16);
  }

  return doc.output("blob") as Blob;
}

export async function sharePortfolioSnapshot(payloadInput: unknown): Promise<ShareDelivery> {
  const payload = sanitizePortfolioSharePayload(payloadInput);
  const blob = await generatePortfolioSnapshotPng(payload);
  return deliverBlob(
    blob,
    `portfolio-snapshot-${Date.now()}.png`,
    "image/png",
    "Portfolio snapshot",
    "Share Portfolio Snapshot"
  );
}

export async function exportPortfolioPdf(payloadInput: unknown): Promise<ShareDelivery> {
  const payload = sanitizePortfolioSharePayload(payloadInput);
  const blob = await generatePortfolioReportPdf(payload);
  return deliverBlob(
    blob,
    `portfolio-report-${Date.now()}.pdf`,
    "application/pdf",
    "Portfolio report",
    "Portfolio Report"
  );
}

function toBase64Url(input: string): string {
  if (typeof window === "undefined") {
    return Buffer.from(input, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }
  return btoa(unescape(encodeURIComponent(input)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function compactPayloadForPublicLink(payloadInput: unknown): PortfolioSharePayload {
  const payload = sanitizePortfolioSharePayload(payloadInput);
  const maxPoints = 12;
  const step =
    payload.performance.length > maxPoints
      ? Math.ceil(payload.performance.length / maxPoints)
      : 1;

  return sanitizePortfolioSharePayload({
    ...payload,
    topHoldings: payload.topHoldings.slice(0, 5),
    allocationMix: payload.allocationMix.slice(0, 6),
    sectorAllocation: payload.sectorAllocation.slice(0, 6),
    performance: payload.performance.filter((_, index) => index % step === 0).slice(-maxPoints),
  });
}

function resolvePublicShareBaseUrl(): string {
  const configured =
    (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_FRONTEND_URL || "")
      .trim()
      .replace(/\/$/, "");
  if (/^https?:\/\//i.test(configured)) return configured;

  if (typeof window !== "undefined") {
    const origin = String(window.location.origin || "").trim().replace(/\/$/, "");
    if (/^https?:\/\//i.test(origin)) {
      return origin;
    }
  }

  return "http://localhost:3000";
}

function buildRawPayloadShareUrl(payloadInput: unknown): string {
  const payload = compactPayloadForPublicLink(payloadInput);
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const token = `raw.${encodedPayload}`;
  const baseUrl = resolvePublicShareBaseUrl();
  return `${baseUrl}/portfolio/shared?token=${encodeURIComponent(token)}`;
}

export async function requestPortfolioShareLink(payloadInput: unknown): Promise<{ url: string; expiresAt: string }> {
  const payload = compactPayloadForPublicLink(payloadInput);

  try {
    const response = await ApiService.createPortfolioShareLink({ payload });
    const body = (await response.json().catch(() => null)) as
      | {
          url?: string;
          expiresAt?: string;
          error?: string;
        }
      | null;

    if (response.ok && body?.url) {
      return {
        url: body.url,
        expiresAt: String(body.expiresAt || ""),
      };
    }
  } catch {
    // Fall through to native-safe client fallback.
  }

  return {
    url: buildRawPayloadShareUrl(payload),
    expiresAt: "",
  };
}

export async function sharePortfolioLink(url: string): Promise<ShareDelivery> {
  if (Capacitor.isNativePlatform()) {
    const { Share } = (await import("@capacitor/share")) as typeof import("@capacitor/share");
    await Share.share({
      title: "Portfolio Snapshot",
      text: "View this portfolio snapshot",
      url,
      dialogTitle: "Share Portfolio Link",
    });
    return "native-share";
  }

  let copied = false;
  try {
    copied = await copyToClipboard(url);
  } catch {
    copied = false;
  }

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({
        title: "Portfolio Snapshot",
        text: "View this portfolio snapshot",
        url,
      });
      return "web-share";
    } catch (error) {
      if (isShareAbortError(error) && copied) {
        return "copied";
      }
      if (!isShareAbortError(error)) {
        // Continue to URL fallback.
      } else if (!copied) {
        throw error;
      }
    }
  }

  if (/^https?:\/\//i.test(url)) {
    openExternalUrl(url);
  }

  if (copied) {
    return "copied";
  }

  throw new Error("Sharing is not supported on this device.");
}

/** Private Finance values. Navigation, provider access and mutations stay in React. */
export type NativeFinanceContent =
  | { kind: "index"; value: string; change: string; tone: "positive" | "negative" | "neutral"; points: readonly number[]; quotedAt: string }
  | { kind: "sector"; value: number; maximum: number }
  | { kind: "security"; style?: "holding" | "mover"; symbol: string; artwork: { glyph: string; hue: number; png?: string }; price: string; change?: number; metadata: string; note?: string }
  | { kind: "headline"; publisher: string; publishedAt: string; sources: readonly { url: string }[] }
  | { kind: "balance"; value: string; change?: string; points: readonly { date: string; value: number }[]; period: string; invested: string; cash: string }
  | { kind: "allocation"; slices: readonly { label: string; value: number; colorHex: string }[]; showBar: boolean }
  | { kind: "briefing"; name?: string; symbol?: string; percent?: number; cash: string; sector?: string; history: string };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, maximum = 256): value is string => typeof value === "string" && !!value.trim() && value.length <= maximum;
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e18;
export function nativeFinanceArtworkSource(source: unknown): boolean {
  if (typeof source !== "string" || source.length > 2048) return false;
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || /^https:\/\/[^/?#]*:/i.test(source) || source.includes("#")) return false;
    if (url.hostname === "financialmodelingprep.com") return !url.search && /^\/image-stock\/[^/\\\x00-\x1f]{1,64}\.png$/.test(decodeURIComponent(url.pathname));
    return ["static.seekingalpha.com", "s.yimg.com", "media.zenfs.com"].includes(url.hostname) && url.pathname.length > 1;
  } catch { return false; }
}
export function validNativeFinanceContent(candidate: unknown): candidate is NativeFinanceContent {
  if (!record(candidate)) return false;
  const v = candidate;
  switch (v.kind) {
    case "index": return closed(v, ["kind", "value", "change", "tone", "points", "quotedAt"]) && text(v.value) && text(v.change) && typeof v.tone === "string" && ["positive", "negative", "neutral"].includes(v.tone) && text(v.quotedAt) && Array.isArray(v.points) && v.points.length <= 1000 && v.points.every(number);
    case "sector": return closed(v, ["kind", "value", "maximum"]) && number(v.value) && number(v.maximum) && v.maximum > 0 && Math.abs(v.value) <= v.maximum;
    case "security": return closed(v, ["kind", "style", "symbol", "artwork", "price", "change", "metadata", "note"]) && (v.style === undefined || typeof v.style === "string" && ["holding", "mover"].includes(v.style)) && text(v.symbol, 64) && text(v.price) && text(v.metadata, 1024) && (v.note === undefined || text(v.note)) && (v.change === undefined || number(v.change)) && record(v.artwork) && closed(v.artwork, ["glyph", "hue", "png"]) && text(v.artwork.glyph, 8) && Number.isInteger(v.artwork.hue) && Number(v.artwork.hue) >= 0 && Number(v.artwork.hue) < 360 && (v.artwork.png === undefined || typeof v.artwork.png === "string" && validNativeSymbolRaster(v.artwork.png));
    case "headline": return closed(v, ["kind", "publisher", "publishedAt", "sources"]) && text(v.publisher) && text(v.publishedAt) && Array.isArray(v.sources) && v.sources.length <= 3 && new Set(v.sources.map(source => record(source) ? source.url : null)).size === v.sources.length && v.sources.every(source => record(source) && closed(source, ["url"]) && nativeFinanceArtworkSource(source.url));
    case "balance": return closed(v, ["kind", "value", "change", "points", "period", "invested", "cash"]) && text(v.value) && (v.change === undefined || text(v.change)) && text(v.period, 1024) && text(v.invested) && text(v.cash) && Array.isArray(v.points) && v.points.length <= 1000 && v.points.every(point => record(point) && closed(point, ["date", "value"]) && text(point.date, 128) && number(point.value));
    case "allocation": return closed(v, ["kind", "slices", "showBar"]) && typeof v.showBar === "boolean" && Array.isArray(v.slices) && v.slices.length <= 32 && v.slices.every(slice => record(slice) && closed(slice, ["label", "value", "colorHex"]) && text(slice.label) && number(slice.value) && slice.value >= 0 && typeof slice.colorHex === "string" && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(slice.colorHex)) && (!v.showBar || v.slices.reduce((sum, slice) => sum + Number(slice.value), 0) <= 100.1);
    case "briefing": return closed(v, ["kind", "name", "symbol", "percent", "cash", "sector", "history"]) && (v.name === undefined || text(v.name)) && (v.symbol === undefined || text(v.symbol, 64)) && (v.percent === undefined || number(v.percent) && v.percent >= 0) && text(v.cash) && (v.sector === undefined || text(v.sector)) && text(v.history);
    default: return false;
  }
}

export function validNativeSymbolRaster(png: string): boolean {
  if (png.length > 40_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(png)) return false;
  try {
    const encoded = png.slice("data:image/png;base64,".length);
    if (encoded.length % 4) return false;
    const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
    if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
        String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return false;
    const view = new DataView(bytes.buffer), width = view.getUint32(16), height = view.getUint32(20);
    return width > 0 && width <= 128 && height > 0 && height <= 128;
  } catch { return false; }
}


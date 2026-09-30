/**
 * Link policy for One's answers, kept pure so it is tested without a DOM.
 *
 * An answer is model output that can quote untrusted content (an email, a
 * Drive file, a web page), so every href is treated as hostile until it is
 * classified here. Only four schemes survive: http, https, mailto and tel,
 * plus in-app paths and in-answer anchors. Everything else, `javascript:`,
 * `data:`, `vbscript:`, `file:` and friends, renders as inert text.
 */

export type ChatHrefKind = "internal" | "external" | "mailto" | "tel" | "anchor" | "unsafe";

const ALLOWED_SCHEME = /^(https?|mailto|tel):/i;
// A scheme is letters then a colon before any slash, query or hash. Browsers
// ignore tabs and newlines inside a URL, so strip them before deciding.
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const IGNORED_URL_CHARACTERS = /[\u0000-\u001f\u007f\s]+/g;

function normalizeHref(href: string | null | undefined): string {
  return (href ?? "").replace(IGNORED_URL_CHARACTERS, "");
}

export function classifyChatHref(href: string | null | undefined): ChatHrefKind {
  const url = normalizeHref(href);
  if (!url) return "unsafe";
  if (url.startsWith("#")) return "anchor";
  if (url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\")) return "internal";
  if (!ANY_SCHEME.test(url)) return "unsafe";
  if (!ALLOWED_SCHEME.test(url)) return "unsafe";
  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();
  if (scheme === "mailto") return "mailto";
  if (scheme === "tel") return "tel";
  return "external";
}

/**
 * The `urlTransform` handed to react-markdown: allowed links pass through
 * unchanged, anything else becomes an empty string, which the link renderer
 * then shows as plain text. react-markdown's default drops `tel:`, so phone
 * numbers were never tappable.
 */
export function chatUrlTransform(url: string): string {
  return classifyChatHref(url) === "unsafe" ? "" : url.trim();
}

function stripScheme(value: string): string {
  return value.trim().replace(/^(https?:\/\/|mailto:|tel:)/i, "").replace(/\/$/, "");
}

/**
 * True when the link's visible text is its own URL: a bare URL the markdown
 * autolinked, or a model that wrote `[https://x](https://x)`. Those render as
 * a compact chip; a written label is kept as the person reads it.
 */
export function isBareChatLink(text: string, href: string): boolean {
  if (classifyChatHref(href) !== "external") return false;
  const label = stripScheme(text).toLowerCase();
  return label.length > 0 && label === stripScheme(href).toLowerCase();
}

const MAX_PATH_CHARACTERS = 24;

/**
 * A tidy label for a bare URL: the domain without `www.` and a short path.
 * A query string or a long path is summarised with an ellipsis; the full URL
 * stays available on hover and to copy.
 */
export function formatBareUrlLabel(href: string): { host: string; path: string } {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { host: stripScheme(href), path: "" };
  }
  const host = url.hostname.replace(/^www\./i, "");
  const rawPath = decodeSafely(url.pathname).replace(/\/$/, "");
  const trimmed =
    rawPath.length > MAX_PATH_CHARACTERS ? `${rawPath.slice(0, MAX_PATH_CHARACTERS)}…` : rawPath;
  const path = url.search || url.hash ? (trimmed.endsWith("…") ? trimmed : `${trimmed}…`) : trimmed;
  return { host, path: path === "…" ? "/…" : path };
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/* ── Phone numbers ──────────────────────────────────────────────────────
   GFM autolinks URLs and email addresses but not phone numbers. Two shapes
   only, so a card number, an amount or a date never turns into a call:
   an international number that starts with `+`, and a North American
   number written 3-3-4 with separators. */

// No lookbehind: WebKit before iOS 16.4 rejects it at parse time, which would
// take the whole chat bundle down. The leading group captures the boundary.
const PHONE_PATTERN =
  /(^|[^\w+/.$-])(\+\d{1,3}(?:[ .-]?(?:\(\d{1,4}\)|\d{1,4})){2,5}|(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4})(?![\w/-]|[.,]\d)/g;

export type PhoneMatch = { index: number; text: string; href: string };

export function findPhoneNumbers(text: string): PhoneMatch[] {
  const matches: PhoneMatch[] = [];
  for (const match of text.matchAll(PHONE_PATTERN)) {
    const boundary = match[1] ?? "";
    const number = match[2];
    if (!number) continue;
    const digits = number.replace(/\D/g, "");
    const international = number.startsWith("+");
    if (international ? digits.length < 8 || digits.length > 15 : digits.length !== 10) continue;
    matches.push({
      index: (match.index ?? 0) + boundary.length,
      text: number,
      href: `tel:${international ? "+" : ""}${digits}`,
    });
  }
  return matches;
}

type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
};

// Content that is already a link, or is code, keeps its text verbatim.
const SKIP_PHONE_LINKING = new Set(["link", "linkReference", "inlineCode", "code", "html", "definition"]);

function linkPhonesIn(parent: MdastNode): void {
  if (!parent.children) return;
  const next: MdastNode[] = [];
  for (const child of parent.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const phones = findPhoneNumbers(child.value);
      let cursor = 0;
      for (const phone of phones) {
        if (phone.index > cursor) next.push({ type: "text", value: child.value.slice(cursor, phone.index) });
        next.push({ type: "link", url: phone.href, children: [{ type: "text", value: phone.text }] });
        cursor = phone.index + phone.text.length;
      }
      if (!phones.length) next.push(child);
      else if (cursor < child.value.length) next.push({ type: "text", value: child.value.slice(cursor) });
      continue;
    }
    if (!SKIP_PHONE_LINKING.has(child.type)) linkPhonesIn(child);
    next.push(child);
  }
  parent.children = next;
}

/** A remark plugin: phone numbers in prose become `tel:` links. */
export function remarkChatPhoneLinks() {
  return (tree: MdastNode) => linkPhonesIn(tree);
}

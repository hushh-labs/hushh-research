"use client";

/** Read-only native attribution. Parse provider HTML as inert content, never
 * execute it or turn its DOM controls into app actions. Only HTTPS citations
 * can be opened through the existing external-link owner. */
export function nativeSearchSuggestions(html: string): { text: string; links: readonly { title: string; url: string }[] } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,template,noscript,iframe,object,embed").forEach(node => node.remove());
  const links = [...doc.querySelectorAll("a[href]")].flatMap(anchor => {
    try {
      const url = new URL(anchor.getAttribute("href") ?? "");
      return url.protocol === "https:" && !url.username && !url.password
        ? [{ title: anchor.textContent?.trim() || url.hostname, url: url.href }] : [];
    } catch { return []; }
  });
  return { text: doc.body.textContent?.trim() ?? "", links };
}

// Google supplies the strip's markup and styling. This only styles the frame
// around it and gives links without a target a direct path to Google results.
const SEARCH_SUGGESTION_FRAME_HEAD = [
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:">`,
  '<meta name="referrer" content="no-referrer">',
  '<meta name="color-scheme" content="light dark">',
  '<base target="_blank">',
  '<style>body { margin: 2px; }</style>',
].join("");

export function SearchSuggestions({ html, index }: { html: string; index: number }) {
  return (
    <iframe
      title={`Google Search suggestions ${index + 1}`}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="block h-14 w-full min-w-0 border-0 scheme-light dark:scheme-dark"
      srcDoc={SEARCH_SUGGESTION_FRAME_HEAD + html}
    />
  );
}

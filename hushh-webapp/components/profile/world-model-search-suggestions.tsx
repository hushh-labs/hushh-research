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

/** Native provider attribution is isolated from app privileges and saved facts. */
export function SearchSuggestions({ html, index }: { html: string; index: number }) {
  return (
    <iframe
      title={`Google Search suggestions ${index + 1}`}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="h-36 w-full border-0"
      srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:">${html}`}
    />
  );
}

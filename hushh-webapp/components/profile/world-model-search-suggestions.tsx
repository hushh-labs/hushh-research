"use client";

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

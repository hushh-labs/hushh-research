import { NextResponse } from "next/server";

const LEGAL_DOC_URLS = {
  privacy: "https://www.hushh.ai/privacy",
  terms: "https://www.hushh.ai/terms",
} as const;

type LegalDoc = keyof typeof LEGAL_DOC_URLS;

function isLegalDoc(value: string): value is LegalDoc {
  return value === "privacy" || value === "terms";
}

function withBaseHref(html: string): string {
  if (/<base\s/i.test(html)) return html;
  return html.replace(/<head([^>]*)>/i, '<head$1><base href="https://www.hushh.ai/">');
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ doc: string }> }
) {
  const { doc } = await params;
  if (!isLegalDoc(doc)) {
    return NextResponse.json({ error: "Unknown legal document." }, { status: 404 });
  }

  const response = await fetch(LEGAL_DOC_URLS[doc], {
    cache: "no-store",
    headers: {
      accept: "text/html",
      "user-agent": "Hussh legal document embed/1.0",
    },
  });

  if (!response.ok) {
    return NextResponse.json(
      { error: "Legal document unavailable." },
      { status: response.status }
    );
  }

  const html = withBaseHref(await response.text());
  return new Response(html, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src https: data: blob:; script-src 'none'; style-src https: 'unsafe-inline'; img-src https: data: blob:; font-src https: data:; frame-ancestors 'self'; base-uri https://www.hushh.ai;",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    },
  });
}

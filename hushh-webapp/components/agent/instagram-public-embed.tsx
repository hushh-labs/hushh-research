"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  canonicalInstagramPublicPostUrl,
  ExternalConnectorService,
} from "@/lib/services/external-connector-service";

/** A public post preview is independent of an Instagram account connection. */
export function InstagramPublicEmbed({ vaultOwnerToken }: { vaultOwnerToken: string }) {
  const [postUrl, setPostUrl] = useState("");
  const [html, setHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    setPostUrl("");
    setHtml(null);
    setBusy(false);
    setMessage("");
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [vaultOwnerToken]);

  const preview = () => {
    const canonical = canonicalInstagramPublicPostUrl(postUrl);
    if (!canonical) {
      setHtml(null);
      setMessage("Enter a public Instagram post or Reel URL.");
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setHtml(null);
    setBusy(true);
    setMessage("");
    void ExternalConnectorService.instagramPublicEmbed({
      vaultOwnerToken,
      postUrl: canonical,
      signal: controller.signal,
    }).then((result) => {
      if (!controller.signal.aborted) setHtml(result.html);
    }).catch(() => {
      if (!controller.signal.aborted) setMessage("Could not preview this post. It may be private or unavailable.");
    }).finally(() => {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    });
  };

  // Meta's omitscript response contains the display blockquote. Its own
  // embed.js runs only inside this opaque-origin iframe, never in the app DOM.
  const srcDoc = html
    ? `<!doctype html><html><head><meta name="referrer" content="no-referrer"></head><body>${html}<script async src="https://www.instagram.com/embed.js"></script></body></html>`
    : undefined;

  return (
    <section className="space-y-3 rounded-xl border border-border p-3" aria-label="Preview a public Instagram post">
      <h3 className="font-semibold">Preview a public post</h3>
      <p className="text-sm text-muted-foreground">
        Paste a public Instagram post or Reel URL to view it here. You can preview without connecting your account.
      </p>
      <label className="block text-sm font-medium" htmlFor="instagram-public-post-url">Instagram post URL</label>
      <input
        id="instagram-public-post-url"
        type="url"
        inputMode="url"
        autoComplete="url"
        className="min-h-11 w-full rounded-lg border border-border bg-background px-3"
        placeholder="https://www.instagram.com/p/.../"
        value={postUrl}
        onChange={(event) => {
          request.current?.abort();
          request.current = null;
          setPostUrl(event.target.value);
          setHtml(null);
          setBusy(false);
          setMessage("");
        }}
      />
      <Button size="compact" disabled={busy || !postUrl} onClick={preview}>
        {busy ? "Loading preview…" : "Preview post"}
      </Button>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{message}</p>
      {srcDoc ? (
        <iframe
          title="Public Instagram post preview"
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-[580px] w-full rounded-lg border border-border bg-background"
        />
      ) : null}
    </section>
  );
}

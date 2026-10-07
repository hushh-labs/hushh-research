"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";

type Props = {
  vaultOwnerToken: string;
  onPublished: () => void;
};

type PublicationKind = "photo" | "reel" | "story_image" | "story_video";

/** Preparing and publishing are separate, explicit owner actions. */
export function InstagramPublisher({ vaultOwnerToken, onPublished }: Props) {
  const [kind, setKind] = useState<PublicationKind>("photo");
  const [mediaUrl, setMediaUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [containerHandle, setContainerHandle] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [publishUncertain, setPublishUncertain] = useState(false);
  const request = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const isStory = kind === "story_image" || kind === "story_video";
  const isImage = kind === "photo" || kind === "story_image";

  useEffect(() => {
    setKind("photo");
    setMediaUrl("");
    setCaption("");
    setContainerHandle(null);
    setStatus(null);
    setMessage("");
    setPublishUncertain(false);
    return () => {
      request.current?.abort();
      request.current = null;
      locked.current = false;
    };
  }, [vaultOwnerToken]);

  const begin = () => {
    if (locked.current) return null;
    locked.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setMessage("");
    return controller;
  };

  const end = (controller: AbortController) => {
    if (request.current === controller) request.current = null;
    locked.current = false;
    if (!controller.signal.aborted) setBusy(false);
  };

  const prepare = () => {
    const controller = begin();
    if (!controller) return;
    setContainerHandle(null);
    setStatus(null);
    setPublishUncertain(false);
    void ExternalConnectorService.instagramPreparePost({
      vaultOwnerToken, kind, mediaUrl, caption, signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      setContainerHandle(result.containerHandle);
      setStatus("IN_PROGRESS");
      setMessage(`${isStory ? "Story" : "Post"} prepared. Check when Instagram finishes processing it.`);
    }).catch(() => {
      if (!controller.signal.aborted) setMessage("Could not prepare this media. Check the public media URL and try again.");
    }).finally(() => end(controller));
  };

  const check = () => {
    if (!containerHandle) return;
    const controller = begin();
    if (!controller) return;
    void ExternalConnectorService.instagramContainerStatus({
      vaultOwnerToken, containerHandle, signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      setStatus(result.status);
      setMessage(result.status === "FINISHED" ? "Ready to publish." : `Instagram status: ${result.status}`);
    }).catch(() => {
      if (!controller.signal.aborted) setMessage("Could not check the media. Try again.");
    }).finally(() => end(controller));
  };

  const publish = () => {
    if (!containerHandle || status !== "FINISHED" || publishUncertain) return;
    const controller = begin();
    if (!controller) return;
    // If the network fails after Meta receives this request, another tap could
    // publish twice. Keep the attempt closed until the owner checks Instagram.
    setPublishUncertain(true);
    void ExternalConnectorService.instagramPublishPost({
      vaultOwnerToken, containerHandle, signal: controller.signal,
    }).then(() => {
      if (controller.signal.aborted) return;
      setMessage("Published on Instagram.");
      setContainerHandle(null);
      setStatus(null);
      onPublished();
    }).catch(() => {
      if (!controller.signal.aborted) setMessage("Publication could not be confirmed. Check Instagram before preparing another item.");
    }).finally(() => end(controller));
  };

  return (
    <section className="space-y-3 rounded-xl border border-border p-3" aria-label="Publish to Instagram">
      <h3 className="font-semibold">Publish to Instagram</h3>
      <p className="text-sm text-muted-foreground">Use a publicly reachable HTTPS photo or video URL. Nothing is published until you select Publish now.</p>
      <label className="block text-sm font-medium" htmlFor="instagram-post-kind">Media type</label>
      <select id="instagram-post-kind" className="min-h-11 w-full rounded-lg border border-border bg-background px-3" value={kind}
        disabled={busy || Boolean(containerHandle)} onChange={(event) => setKind(event.target.value as PublicationKind)}>
        <option value="photo">Photo</option>
        <option value="reel">Reel</option>
        <option value="story_image">Photo Story</option>
        <option value="story_video">Video Story</option>
      </select>
      <label className="block text-sm font-medium" htmlFor="instagram-media-url">Public {isImage ? "photo" : "video"} URL</label>
      <input id="instagram-media-url" className="min-h-11 w-full rounded-lg border border-border bg-background px-3" type="url"
        value={mediaUrl} disabled={busy || Boolean(containerHandle)} onChange={(event) => setMediaUrl(event.target.value)}
        placeholder="https://example.com/media" />
      {!isStory && (
        <>
          <label className="block text-sm font-medium" htmlFor="instagram-caption">Caption</label>
          <textarea id="instagram-caption" className="min-h-24 w-full rounded-lg border border-border bg-background p-3"
            maxLength={2200} value={caption} disabled={busy || Boolean(containerHandle)} onChange={(event) => setCaption(event.target.value)} />
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {!containerHandle && <Button size="compact" disabled={busy || !mediaUrl.trim()} onClick={prepare}>Prepare {isStory ? "story" : "post"}</Button>}
        {containerHandle && <Button size="compact" variant="outline" disabled={busy} onClick={check}>Check readiness</Button>}
        {containerHandle && status === "FINISHED" && !publishUncertain && (
          <Button size="compact" disabled={busy} onClick={publish}>Publish now</Button>
        )}
        {containerHandle && !busy && (
          <Button size="compact" variant="outline" onClick={() => { setContainerHandle(null); setStatus(null); setPublishUncertain(false); setMessage("Draft discarded in One."); }}>
            Discard draft
          </Button>
        )}
      </div>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{busy ? "Working…" : message}</p>
    </section>
  );
}

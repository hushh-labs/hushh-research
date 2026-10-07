"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ExternalConnectorService,
  type InstagramOwnedPost,
} from "@/lib/services/external-connector-service";

/** Only the connected owner's media is available through Instagram Login. */
export function InstagramOwnedPosts({ vaultOwnerToken }: { vaultOwnerToken: string }) {
  const [posts, setPosts] = useState<InstagramOwnedPost[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setPosts([]);
    setNextCursor(null);
    setLoading(true);
    setMessage("");
    void ExternalConnectorService.instagramOwnedMedia({
      vaultOwnerToken,
      signal: controller.signal,
    }).then((page) => {
      if (controller.signal.aborted) return;
      setPosts(page.posts);
      setNextCursor(page.nextCursor);
    }).catch(() => {
      if (!controller.signal.aborted) setMessage("Could not load Instagram posts. Try again.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [vaultOwnerToken]);

  const loadMore = () => {
    if (!nextCursor || loading) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setMessage("");
    void ExternalConnectorService.instagramOwnedMedia({
      vaultOwnerToken,
      after: nextCursor,
      signal: controller.signal,
    }).then((page) => {
      if (controller.signal.aborted) return;
      setPosts((existing) => {
        const seen = new Set(existing.map((post) => post.id));
        return [...existing, ...page.posts.filter((post) => !seen.has(post.id))];
      });
      setNextCursor(page.nextCursor);
    }).catch(() => {
      if (!controller.signal.aborted) setMessage("Could not load more Instagram posts. Try again.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
  };

  return (
    <section className="space-y-3 rounded-xl border border-border p-3" aria-label="Your Instagram posts">
      <h3 className="font-semibold">Your Instagram posts</h3>
      <p className="text-sm text-muted-foreground">
        Open a post's public Instagram URL. Only posts from the account you connected appear here.
      </p>
      {posts.map((post) => (
        <div key={post.id} className="space-y-1 rounded-lg border border-border p-3">
          <p className="line-clamp-2 text-sm">{post.caption || post.mediaType || "Instagram post"}</p>
          <p className="text-xs text-muted-foreground">Media ID: {post.id}</p>
          <a className="text-sm underline underline-offset-2" href={post.permalink} target="_blank" rel="noopener noreferrer">
            Open on Instagram
          </a>
        </div>
      ))}
      {!loading && posts.length === 0 && !message && (
        <p className="text-sm text-muted-foreground">No posts found.</p>
      )}
      {nextCursor && (
        <Button size="compact" variant="outline" disabled={loading} onClick={loadMore}>
          Load more posts
        </Button>
      )}
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {loading ? "Loading posts…" : message}
      </p>
    </section>
  );
}

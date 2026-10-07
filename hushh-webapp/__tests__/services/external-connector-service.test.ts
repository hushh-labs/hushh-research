import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch,
    getAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  },
}));

import {
  CONNECTOR_OAUTH_START_TIMEOUT_MS,
  ExternalConnectorService,
} from "@/lib/services/external-connector-service";

describe("ExternalConnectorService native Drive OAuth", () => {
  beforeEach(() => apiFetch.mockReset());
  afterEach(() => vi.useRealTimers());

  it("uses the Instagram management route contracts and owner authorization", async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ comments: [{ id: "88", text: "hello", timestamp: "2026-10-07", username: "alice", hidden: false }], nextCursor: null }));
    await expect(ExternalConnectorService.instagramComments({ vaultOwnerToken: "owner-token", mediaId: "42" }))
      .resolves.toMatchObject({ comments: [{ id: "88" }] });
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/api/connectors/instagram/media/42/comments?limit=25",
      expect.objectContaining({ method: "GET", cache: "no-store", headers: { Authorization: "Bearer owner-token" } }),
    );

    apiFetch.mockResolvedValueOnce(Response.json({ commentId: "89" }));
    await ExternalConnectorService.instagramReplyToComment({ vaultOwnerToken: "owner-token", commentId: "88", message: "Thanks" });
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/api/connectors/instagram/comments/88/reply",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmed: true, message: "Thanks" }) }),
    );

    apiFetch.mockResolvedValueOnce(Response.json({ hidden: true }));
    await ExternalConnectorService.instagramSetCommentHidden({ vaultOwnerToken: "owner-token", commentId: "88", hidden: true });
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/api/connectors/instagram/comments/88/hide",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmed: true, hidden: true }) }),
    );

    apiFetch.mockResolvedValueOnce(Response.json({ deleted: true }));
    await ExternalConnectorService.instagramDeleteComment({ vaultOwnerToken: "owner-token", commentId: "88" });
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/api/connectors/instagram/comments/88/delete",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmed: true }) }),
    );
  });

  it("reads Instagram insights, tags and an exact recipient conversation", async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ metric: "reach", available: true, value: 12 }));
    await expect(ExternalConnectorService.instagramAccountInsight({ vaultOwnerToken: "owner-token", metric: "reach" }))
      .resolves.toEqual({ metric: "reach", available: true, value: 12 });
    expect(apiFetch.mock.calls[0][0]).toBe("/api/connectors/instagram/insights/account?metric=reach");

    apiFetch.mockResolvedValueOnce(Response.json({ metric: "likes", available: false, value: null }));
    await ExternalConnectorService.instagramMediaInsight({ vaultOwnerToken: "owner-token", mediaId: "42", metric: "likes" });
    expect(apiFetch.mock.calls[1][0]).toBe("/api/connectors/instagram/insights/media/42?metric=likes");

    apiFetch.mockResolvedValueOnce(Response.json({ media: [{ id: "9", username: "alice", permalink: "https://www.instagram.com/p/ABC/", timestamp: "today" }], nextCursor: null }));
    await ExternalConnectorService.instagramTaggedMedia({ vaultOwnerToken: "owner-token" });
    expect(apiFetch.mock.calls[2][0]).toBe("/api/connectors/instagram/tags?limit=25");

    apiFetch.mockResolvedValueOnce(Response.json({ messages: [{ id: "mid_1", senderId: "77", createdTime: "today", text: "Hello" }] }));
    await ExternalConnectorService.instagramRecentMessages({ vaultOwnerToken: "owner-token", recipientId: "77" });
    expect(apiFetch.mock.calls[3][0]).toBe("/api/connectors/instagram/messages/77");

    apiFetch.mockResolvedValueOnce(Response.json({ messageId: "mid_2" }));
    await ExternalConnectorService.instagramSendTextMessage({ vaultOwnerToken: "owner-token", recipientId: "77", message: "Hi" });
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/api/connectors/instagram/messages/77/send",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmed: true, message: "Hi" }) }),
    );
  });

  it("rejects invalid Instagram IDs, cursors and oversized message bytes before network I/O", async () => {
    await expect(ExternalConnectorService.instagramComments({ vaultOwnerToken: "owner-token", mediaId: "../../messages" })).rejects.toThrow();
    await expect(ExternalConnectorService.instagramTaggedMedia({ vaultOwnerToken: "owner-token", after: "bad!cursor" })).rejects.toThrow();
    await expect(ExternalConnectorService.instagramSendTextMessage({ vaultOwnerToken: "owner-token", recipientId: "77", message: "😊".repeat(300) })).rejects.toThrow("1,000 bytes");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("treats a malformed Instagram write response as unconfirmed", async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ commentId: "invalid" }));
    await expect(ExternalConnectorService.instagramReplyToComment({ vaultOwnerToken: "owner-token", commentId: "88", message: "hello" }))
      .rejects.toThrow("could not be confirmed");
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it("routes Story media to the dedicated containers without a caption", async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ containerHandle: `igc1.${"a".repeat(10)}.${"b".repeat(64)}`, kind: "story_image" }));
    await ExternalConnectorService.instagramPreparePost({ vaultOwnerToken: "owner-token", kind: "story_image", mediaUrl: "https://example.com/photo.jpg", caption: "omit" });
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/api/connectors/instagram/media/story-image-container",
      expect.objectContaining({ body: JSON.stringify({ imageUrl: "https://example.com/photo.jpg", confirmed: true }) }),
    );
    apiFetch.mockResolvedValueOnce(Response.json({ containerHandle: `igc1.${"a".repeat(10)}.${"b".repeat(64)}`, kind: "story_video" }));
    await ExternalConnectorService.instagramPreparePost({ vaultOwnerToken: "owner-token", kind: "story_video", mediaUrl: "https://example.com/video.mp4", caption: "omit" });
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/api/connectors/instagram/media/story-video-container",
      expect.objectContaining({ body: JSON.stringify({ videoUrl: "https://example.com/video.mp4", confirmed: true }) }),
    );
  });

  it("reads Instagram media with the vault owner grant and rejects an untrusted permalink", async () => {
    const safe = {
      id: "123",
      caption: "Owner post",
      mediaType: "IMAGE",
      permalink: "https://www.instagram.com/p/example/",
    };
    apiFetch.mockResolvedValueOnce(Response.json({ posts: [safe], nextCursor: null }));
    const controller = new AbortController();
    await expect(ExternalConnectorService.instagramOwnedMedia({
      vaultOwnerToken: "owner-token", after: "next_page", signal: controller.signal,
    })).resolves.toEqual({ posts: [safe], nextCursor: null });
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/connectors/instagram/media?limit=25&after=next_page",
      expect.objectContaining({
        method: "GET", cache: "no-store", signal: controller.signal,
        headers: { Authorization: "Bearer owner-token" },
      }),
    );

    apiFetch.mockResolvedValueOnce(Response.json({
      posts: [{ ...safe, permalink: "https://other.example/p/example/" }], nextCursor: null,
    }));
    await expect(ExternalConnectorService.instagramOwnedMedia({
      vaultOwnerToken: "owner-token",
    })).rejects.toThrow("Instagram posts changed");
  });

  it("discards private OAuth delivery after vault authority changes", async () => {
    let current = true;
    apiFetch.mockImplementationOnce(async () => {
      current = false;
      return Response.json({ tokens: { access_token: "synthetic-private" } });
    });
    await expect(ExternalConnectorService.privateMcpOAuth({ vaultOwnerToken: "owner-token",
      connectorId: "custom_" + "a".repeat(32), operation: "complete", payload: {},
      signal: new AbortController().signal, isEffectCurrent: () => current,
    })).rejects.toThrow("Connection was not completed");
  });

  it("does not echo a provider failure or retry an OAuth completion", async () => {
    apiFetch.mockResolvedValue(Response.json({ detail: "synthetic-private-provider-error" }, { status: 409 }));
    await expect(ExternalConnectorService.privateMcpOAuth({ vaultOwnerToken: "owner-token",
      connectorId: "custom_" + "a".repeat(32), operation: "complete", payload: {},
      signal: new AbortController().signal, isEffectCurrent: () => true,
    })).rejects.toThrow("Connection was not completed. Please connect again.");
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it("starts a native attempt with the exact flow and effect guard", async () => {
    const isEffectCurrent = vi.fn(() => true);
    apiFetch.mockResolvedValue(
      Response.json({
        authorizeUrl:
          "https://accounts.google.com/o/oauth2/v2/auth?synthetic=1",
        expiresAt: "2026-09-23T12:00:00+00:00",
        attemptId: "attempt_123456789012",
        connectorId: "google_drive",
      }),
    );

    await expect(
      ExternalConnectorService.startOAuthConnect({
        vaultOwnerToken: "owner-token",
        connectorId: "google_drive",
        redirectUri:
          "https://api.uat.hushh.ai/api/connectors/oauth/native/callback",
        flow: "native",
        isEffectCurrent,
      }),
    ).resolves.toMatchObject({ attemptId: "attempt_123456789012" });

    expect(apiFetch).toHaveBeenCalledWith(
      "/api/connectors/google_drive/connect/oauth/start",
      expect.objectContaining({
        method: "POST",
        isEffectCurrent,
        body: JSON.stringify({
          redirectUri:
            "https://api.uat.hushh.ai/api/connectors/oauth/native/callback",
          flow: "native",
          profile: "selected",
        }),
      }),
    );
  });

  it("forwards cancellation to the web OAuth-start request", async () => {
    const ownerAbort = new AbortController();
    let resolveFetch!: (response: Response) => void;
    apiFetch.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );

    const pending = ExternalConnectorService.startOAuthConnect({
      vaultOwnerToken: "owner-token",
      connectorId: "google_drive",
      redirectUri: "https://app.test/one/profile/connectors/oauth/return",
      flow: "web",
      signal: ownerAbort.signal,
    });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
    const requestSignal = (apiFetch.mock.calls[0][1] as { signal: AbortSignal })
      .signal;
    ownerAbort.abort(new DOMException("Aborted", "AbortError"));

    await expect(pending).rejects.toThrow("Aborted");
    expect(requestSignal).not.toBe(ownerAbort.signal);
    expect(requestSignal.aborted).toBe(true);
    resolveFetch(Response.json({}));
  });

  it("bounds a stalled OAuth-start JSON response after headers arrive", async () => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValue(
      new Response(new ReadableStream({ start() {} }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    const pending = ExternalConnectorService.startOAuthConnect({
      vaultOwnerToken: "owner-token",
      connectorId: "google_drive",
      redirectUri: "https://app.test/one/profile/connectors/oauth/return",
      flow: "web",
    });
    const assertion = expect(pending).rejects.toThrow(
      "OAuth sign-in took too long. Check the connection and try again.",
    );
    await vi.advanceTimersByTimeAsync(CONNECTOR_OAUTH_START_TIMEOUT_MS);
    await assertion;
  });

  it("reconciles only the opaque pending reference before finalization", async () => {
    const isEffectCurrent = vi.fn(() => true);
    apiFetch
      .mockResolvedValueOnce(
        Response.json({
          pending: {
            attemptId: "attempt_123456789012",
            expiresAt: "2026-09-23T12:00:00+00:00",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ status: "verifying", connectorId: "google_drive" }),
      );

    await expect(
      ExternalConnectorService.pendingNative({
        vaultOwnerToken: "owner-token",
        isEffectCurrent,
      }),
    ).resolves.toEqual({
      attemptId: "attempt_123456789012",
      expiresAt: "2026-09-23T12:00:00+00:00",
    });
    await expect(
      ExternalConnectorService.finalizeNative({
        vaultOwnerToken: "owner-token",
        attemptId: "attempt_123456789012",
        isEffectCurrent,
      }),
    ).resolves.toEqual({ status: "verifying", connectorId: "google_drive" });

    expect(apiFetch.mock.calls[0][0]).toBe(
      "/api/connectors/oauth/native/pending",
    );
    expect(apiFetch.mock.calls[0][1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      isEffectCurrent,
    });
    expect(apiFetch.mock.calls[1][0]).toBe(
      "/api/connectors/oauth/native/finalize",
    );
    expect(apiFetch.mock.calls[1][1]).toMatchObject({
      method: "POST",
      isEffectCurrent,
      body: JSON.stringify({ attemptId: "attempt_123456789012" }),
    });
    expect(JSON.stringify(apiFetch.mock.calls)).not.toContain("accessToken");
    expect(JSON.stringify(apiFetch.mock.calls)).not.toContain("refreshToken");
  });

  it("keeps native Picker candidates server-staged until the owner confirms", async () => {
    const isEffectCurrent = vi.fn(() => true);
    apiFetch
      .mockResolvedValueOnce(
        Response.json({
          authorizeUrl:
            "https://accounts.google.com/o/oauth2/v2/auth?synthetic=picker",
          expiresAt: "2026-09-23T12:00:00+00:00",
          attemptId: "picker_1234567890123",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          pending: {
            attemptId: "picker_1234567890123",
            expiresAt: "2026-09-23T12:00:00+00:00",
            files: [
              {
                documentId: "drive_file_123456789012",
                name: "Statement.pdf",
                mimeType: "application/pdf",
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ documents: [] }))
      .mockResolvedValueOnce(Response.json({}));

    await expect(
      ExternalConnectorService.startNativePicker({
        vaultOwnerToken: "owner-token",
        redirectUri:
          "https://api.uat.hushh.ai/api/connectors/google_drive/picker/native/callback",
        isEffectCurrent,
      }),
    ).resolves.toMatchObject({ attemptId: "picker_1234567890123" });
    await expect(
      ExternalConnectorService.pendingNativePicker({
        vaultOwnerToken: "owner-token",
        isEffectCurrent,
      }),
    ).resolves.toMatchObject({ attemptId: "picker_1234567890123" });

    // Reading a staged candidate does not confirm it.
    expect(apiFetch.mock.calls.map((call) => call[0])).not.toContain(
      "/api/connectors/google_drive/picker/native/confirm",
    );

    await ExternalConnectorService.confirmNativePicker({
      vaultOwnerToken: "owner-token",
      attemptId: "picker_1234567890123",
      isEffectCurrent,
    });
    await ExternalConnectorService.cancelNativePicker({
      vaultOwnerToken: "owner-token",
      attemptId: "picker_1234567890123",
      isEffectCurrent,
    });

    expect(apiFetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/connectors/google_drive/picker/native/start",
      "/api/connectors/google_drive/picker/native/pending",
      "/api/connectors/google_drive/picker/native/confirm",
      "/api/connectors/google_drive/picker/native/cancel",
    ]);
    expect(JSON.stringify(apiFetch.mock.calls)).not.toContain("accessToken");
    expect(JSON.stringify(apiFetch.mock.calls)).not.toContain("refreshToken");
  });
});

describe("ExternalConnectorService live Drive background preparation", () => {
  beforeEach(() => apiFetch.mockReset());

  it("reads and sets live background preparation with explicit confirmation", async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ enabled: true }));
    await expect(ExternalConnectorService.liveBackground("owner-token")).resolves.toBe(true);
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/api/connectors/google_drive/live/background",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: { Authorization: "Bearer owner-token" },
      }),
    );

    // An invalid response must not masquerade as a user choice to turn it off.
    apiFetch.mockResolvedValueOnce(Response.json({ enabled: "true" }));
    await expect(ExternalConnectorService.liveBackground("owner-token")).rejects.toThrow("Invalid background Drive access state");
    apiFetch.mockResolvedValueOnce(Response.json({}));
    await expect(ExternalConnectorService.liveBackground("owner-token")).rejects.toThrow("Invalid background Drive access state");

    apiFetch.mockResolvedValueOnce(Response.json({ enabled: true }));
    await expect(ExternalConnectorService.setLiveBackground("owner-token", true)).resolves.toBe(true);
    const [path, init] = apiFetch.mock.calls.at(-1)!;
    expect(path).toBe("/api/connectors/google_drive/live/background");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ enabled: true, confirmed: true });
    expect(init.headers).toEqual({
      Authorization: "Bearer owner-token",
      "Content-Type": "application/json",
    });

    apiFetch.mockResolvedValueOnce(Response.json({ enabled: false }));
    await expect(ExternalConnectorService.setLiveBackground("owner-token", false)).resolves.toBe(false);
    apiFetch.mockResolvedValueOnce(Response.json({ enabled: true }));
    await expect(ExternalConnectorService.setLiveBackground("owner-token", false)).rejects.toThrow("Background Drive access state was not confirmed");
  });
});

describe("ExternalConnectorService Instagram publishing", () => {
  const handle = `igc1.container.${"a".repeat(64)}`;

  beforeEach(() => apiFetch.mockReset());

  it("prepares photos and reels with explicit confirmation and keeps publishing separate", async () => {
    const controller = new AbortController();
    apiFetch
      .mockResolvedValueOnce(Response.json({ containerHandle: handle, kind: "photo" }))
      .mockResolvedValueOnce(Response.json({ containerHandle: handle, kind: "reel" }));

    await expect(ExternalConnectorService.instagramPreparePost({
      vaultOwnerToken: "owner-token", kind: "photo",
      mediaUrl: "https://media.example/photo.jpg", caption: "Approved photo",
      signal: controller.signal,
    })).resolves.toEqual({ containerHandle: handle, kind: "photo" });
    expect(apiFetch).toHaveBeenNthCalledWith(1,
      "/api/connectors/instagram/media/photo-container",
      expect.objectContaining({
        method: "POST", cache: "no-store", signal: controller.signal,
        headers: {
          Authorization: "Bearer owner-token", "Content-Type": "application/json",
        },
        body: JSON.stringify({
          imageUrl: "https://media.example/photo.jpg",
          caption: "Approved photo", confirmed: true,
        }),
      }),
    );

    await expect(ExternalConnectorService.instagramPreparePost({
      vaultOwnerToken: "owner-token", kind: "reel",
      mediaUrl: "https://media.example/reel.mp4", caption: "Approved reel",
    })).resolves.toEqual({ containerHandle: handle, kind: "reel" });
    expect(apiFetch).toHaveBeenNthCalledWith(2,
      "/api/connectors/instagram/media/reel-container",
      expect.objectContaining({
        body: JSON.stringify({
          videoUrl: "https://media.example/reel.mp4",
          caption: "Approved reel", confirmed: true,
        }),
      }),
    );
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls.map(([path]) => path)).not.toContain(
      "/api/connectors/instagram/media/publish",
    );
  });

  it("checks a prepared container and publishes that handle exactly once on an explicit call", async () => {
    const controller = new AbortController();
    apiFetch
      .mockResolvedValueOnce(Response.json({ kind: "photo", status: "FINISHED" }))
      .mockResolvedValueOnce(Response.json({ mediaId: "123456" }));

    await expect(ExternalConnectorService.instagramContainerStatus({
      vaultOwnerToken: "owner-token", containerHandle: handle,
      signal: controller.signal,
    })).resolves.toEqual({ kind: "photo", status: "FINISHED" });
    expect(apiFetch).toHaveBeenNthCalledWith(1,
      `/api/connectors/instagram/media/containers/${encodeURIComponent(handle)}`,
      expect.objectContaining({
        method: "GET", cache: "no-store", signal: controller.signal,
        headers: { Authorization: "Bearer owner-token" },
      }),
    );

    await expect(ExternalConnectorService.instagramPublishPost({
      vaultOwnerToken: "owner-token", containerHandle: handle,
      signal: controller.signal,
    })).resolves.toEqual({ mediaId: "123456" });
    expect(apiFetch).toHaveBeenNthCalledWith(2,
      "/api/connectors/instagram/media/publish",
      expect.objectContaining({
        method: "POST", cache: "no-store", signal: controller.signal,
        headers: {
          Authorization: "Bearer owner-token", "Content-Type": "application/json",
        },
        body: JSON.stringify({ containerHandle: handle, confirmed: true }),
      }),
    );
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid provider receipts and never retries an uncertain publish", async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ containerHandle: "bad", kind: "photo" }));
    await expect(ExternalConnectorService.instagramPreparePost({
      vaultOwnerToken: "owner-token", kind: "photo",
      mediaUrl: "https://media.example/photo.jpg", caption: "",
    })).rejects.toThrow("post preparation could not be verified");
    expect(apiFetch).toHaveBeenCalledOnce();

    apiFetch.mockResolvedValueOnce(Response.json({ mediaId: "not-an-id" }));
    await expect(ExternalConnectorService.instagramPublishPost({
      vaultOwnerToken: "owner-token", containerHandle: handle,
    })).rejects.toThrow("publication could not be verified");
    expect(apiFetch).toHaveBeenCalledTimes(2);

    apiFetch.mockRejectedValueOnce(new Error("ambiguous transport failure"));
    await expect(ExternalConnectorService.instagramPublishPost({
      vaultOwnerToken: "owner-token", containerHandle: handle,
    })).rejects.toThrow("ambiguous transport failure");
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });
});

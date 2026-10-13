import { z } from "zod";
import { apiJson } from "@/lib/services/api-client";
import type { ApiFetchOptions } from "@/lib/services/api-service";
import { oneChatKeyHeaders } from "@/lib/vault/one-chat-key";
import { resolveShareableAppOrigin } from "@/lib/share/app-origin";
import { ROUTES } from "@/lib/navigation/routes";

type Session = {
  vaultKey: string;
  vaultOwnerToken: string;
  isCurrent: () => boolean;
  signal?: AbortSignal;
};

function requireCurrent(session: Session) {
  if (session.signal?.aborted || !session.isCurrent())
    throw new DOMException("Owner session ended", "AbortError");
}
const invitation = z
  .object({
    id: z.string().uuid(),
    state: z.enum(["pending", "claimed", "revoked"]),
    created_at: z.string(),
    expires_at: z.string(),
  })
  .strict();
export type WorldModelInvitation = z.infer<typeof invitation>;
async function request(
  session: Session,
  path: string,
  method: string,
  body?: unknown,
) {
  requireCurrent(session);
  const keyHeaders = await oneChatKeyHeaders(session.vaultKey);
  requireCurrent(session);
  const options: ApiFetchOptions = {
    method,
    cache: "no-store",
    signal: session.signal,
    isEffectCurrent: session.isCurrent,
    headers: {
      Authorization: `Bearer ${session.vaultOwnerToken}`,
      "Content-Type": "application/json",
      ...keyHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const result = await apiJson(`/api/one/world-model/${path}`, options);
  requireCurrent(session);
  return result;
}
export const WorldModelInvitationsService = {
  async create(session: Session, contact: string) {
    const origin = resolveShareableAppOrigin();
    if (!origin) throw new Error("A shareable app address is unavailable.");
    const row = z
      .object({
        id: z.string().uuid(),
        token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        expires_at: z.string(),
      })
      .strict()
      .parse(await request(session, "invitations", "POST", { contact }));
    return {
      ...row,
      url: `${origin}${ROUTES.PROFILE_WORLD_MODEL}?claim=${encodeURIComponent(row.token)}`,
    };
  },
  async list(session: Session) {
    return z
      .object({ invitations: z.array(invitation).max(20) })
      .strict()
      .parse(await request(session, "invitations", "GET")).invitations;
  },
  async revoke(session: Session, id: string) {
    z.object({ revoked: z.literal(true) })
      .strict()
      .parse(
        await request(
          session,
          `invitations/${encodeURIComponent(id)}`,
          "DELETE",
        ),
      );
  },
  async claim(session: Session, token: string) {
    return z
      .object({
        claimed: z.literal(true),
        sharing_granted: z.literal(false),
        research_started: z.literal(false),
      })
      .strict()
      .parse(
        await request(session, "claims", "POST", { token, consent: true }),
      );
  },
};

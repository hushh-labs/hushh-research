import { apiJson } from "@/lib/services/api-client";
import { oneChatKeyHeaders } from "@/lib/vault/one-chat-key";
import { profileResearchResultSchema } from "@/lib/services/profile-research-service";
import type { PwmAuthority } from "@/lib/services/world-model-research-service";
export type SourceInput = {
  name: string;
  urls: string[];
  purpose: "owner" | "invitation";
  permitted_public_sources: true;
};
export const WorldModelSourceService = {
  async read(input: PwmAuthority) {
    return this.request(input);
  },
  async prepare(input: PwmAuthority, body: SourceInput) {
    return this.request(input, body);
  },
  async request(
    input: PwmAuthority,
    body?: SourceInput,
    purpose: "owner" | "invitation" = "owner",
  ) {
    await input.assertCurrent?.();
    const headers = await oneChatKeyHeaders(input.vaultKey);
    await input.assertCurrent?.();
    const result = await apiJson(
      `/api/one/world-model/source-reviews${body ? "" : `?purpose=${purpose}`}`,
      {
        method: body ? "POST" : "GET",
        cache: "no-store",
        signal: input.signal,
        headers: {
          Authorization: `Bearer ${input.vaultOwnerToken}`,
          "Content-Type": "application/json",
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    await input.assertCurrent?.();
    return profileResearchResultSchema.parse(result);
  },
};

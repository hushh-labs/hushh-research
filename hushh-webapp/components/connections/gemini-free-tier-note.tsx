import { HelperText } from "@/components/app-ui/typography";
import type { GeminiRuntimeTransport } from "@/lib/services/personal-knowledge-model-service";

export const GEMINI_FREE_TIER_NOTE =
  "Use a paid Gemini key for a private agent. On Google's free tier, Google may use your messages and memories to improve its products, and its reviewers may read them.";

/**
 * Shown, unconditionally, wherever a person enters a Google AI Studio Gemini key.
 *
 * Google's Gemini API terms say unpaid use may improve Google products and may be
 * read by human reviewers. Hussh cannot tell a paid key from an unpaid one, so this
 * never claims to have checked: it states the rule for every AI Studio key. A Vertex
 * API key bills a Google Cloud project and falls under Google Cloud's terms, so it
 * does not carry the note; neither do other providers' keys.
 */
export function GeminiFreeTierNote({ transport }: { transport: GeminiRuntimeTransport }) {
  if (transport !== "developer_api") return null;
  return (
    <HelperText id="gemini-free-tier-note" data-testid="gemini-free-tier-note">
      {GEMINI_FREE_TIER_NOTE}
    </HelperText>
  );
}

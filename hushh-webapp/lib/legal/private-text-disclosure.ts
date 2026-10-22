/** The exact disclosure acknowledged by the private Azure UAT approval API. */
export const PRIVATE_TEXT_DISCLOSURE_VERSION = "one-private-azure-text-v1";

type ManagedTextProvider = "azure_openai" | "gemini";

export function managedTextProcessorName(provider?: ManagedTextProvider | null): string | null {
  return provider === "azure_openai" ? "Microsoft Azure AI"
    : provider === "gemini" ? "Google Gemini" : null;
}

/** Administrator rollout; this text never creates an owner acceptance receipt. */
export function managedTextDisclosure(provider?: ManagedTextProvider | null): readonly string[] {
  const primary = managedTextProcessorName(provider);
  const alternate = provider === "azure_openai" ? "Google Gemini"
    : provider === "gemini" ? "Microsoft Azure AI" : "The other provider";
  return [
    `In UAT, ${primary ? `${primary} is the server-managed primary processor` : "Hussh selects Microsoft Azure AI or Google Gemini as the primary processor"} for One text chat and Google Drive document-request planning, for every existing and new account. New Drive requests deliver search matches without reading each file or running a relevance assessment. Older requests and other document features may still process document text. The selected processor may receive messages, relevant conversation history and memories, shared information, request purposes and relevant document text. This may include sensitive personal or financial details.`,
    `${alternate} is a fallback only after a classified temporary ${primary ?? "primary processor"} model-service failure, such as a timeout, quota exhaustion or transient service error, before any output. Authentication, access denial and invalid consent do not authorize fallback. Attempts and deadlines are bounded. Native Google Search, public research, voice and your own-key settings have separate provider behavior.`,
    "This processing is governed by a versioned UAT administrator policy. No model-settings toggle or personal pilot approval is required or created. Earlier pilot approval or revocation records are retained as history; they do not select the processor under this policy. Your vault key and Google credentials are not sent to the model. Current file access, owner consent, payment requirements and sharing permissions still apply. Recovery of eligible pending requests is recorded; completed payment and sharing history is not rewritten.",
  ];
}

export const DRIVE_AZURE_DEFAULT_DISCLOSURE = managedTextDisclosure("azure_openai");
export const UAT_MANAGED_TEXT_DISCLOSURE = managedTextDisclosure();

export const PRIVATE_TEXT_DISCLOSURE = [
  "One normally uses Google Gemini. This optional UAT pilot allows Microsoft Azure AI to process your private agent's text conversations and the planning and relevance checks for document requests it handles.",
  "Azure may receive your messages, relevant conversation history and memories, information from connected services or people who shared with you, and document-request purposes and relevant document text. This may include sensitive personal or financial details. Your vault key and connector credentials are not sent to the model.",
  "Your approval is saved to your account before Azure is allowed. The pilot must also be enabled in this UAT environment. Without current approval, the pilot cannot send these private text requests to Azure. Voice and your own-key settings stay separate. This approval does not enable Bing search or Personal World Model research.",
  "You can revoke approval from One's model settings at any time. Revocation blocks new private Azure text requests; it cannot undo processing already sent. Your existing storage, sharing permissions and reviews remain in place.",
] as const;

/** The exact disclosure acknowledged by the private Azure UAT approval API. */
export const PRIVATE_TEXT_DISCLOSURE_VERSION = "one-private-azure-text-v1";

export const PRIVATE_TEXT_DISCLOSURE = [
  "One normally uses Google Gemini. This optional UAT pilot allows Microsoft Azure AI to process your private agent's text conversations and the planning and relevance checks for document requests it handles.",
  "Azure may receive your messages, relevant conversation history and memories, information from connected services or people who shared with you, and document-request purposes and relevant document text. This may include sensitive personal or financial details. Your vault key and connector credentials are not sent to the model.",
  "Your approval is saved to your account before Azure is allowed. The pilot must also be enabled in this UAT environment. Without current approval, the pilot cannot send these private text requests to Azure. Voice and your own-key settings stay separate. This approval does not enable Bing search or Personal World Model research.",
  "You can revoke approval from One's model settings at any time. Revocation blocks new private Azure text requests; it cannot undo processing already sent. Your existing storage, sharing permissions and reviews remain in place.",
] as const;

/** The exact disclosure acknowledged by the private Azure UAT approval API. */
export const PRIVATE_TEXT_DISCLOSURE_VERSION = "one-private-azure-text-v1";

/** Administrator rollout; this text is not an owner acceptance receipt. */
export const DRIVE_AZURE_DEFAULT_DISCLOSURE = [
  "In UAT, new document requests use Microsoft Azure AI by default for search planning and document relevance checks. This applies to existing and new accounts. Azure may receive the request purpose and relevant document text, including sensitive personal or financial details.",
  "This is the UAT administrator's processing policy, not a record that you personally approved the optional text pilot. Your vault key and Google credentials are not sent to the model. It does not switch your private agent's chat, voice, your own-key settings, or public research.",
  "You can turn Azure processing off here. Existing refusals and revocations are respected. Requests already started keep their original provider; this default does not change file access, sharing consent, prices or payment requirements.",
] as const;

export const PRIVATE_TEXT_DISCLOSURE = [
  "One normally uses Google Gemini. This optional UAT pilot allows Microsoft Azure AI to process your private agent's text conversations and the planning and relevance checks for document requests it handles.",
  "Azure may receive your messages, relevant conversation history and memories, information from connected services or people who shared with you, and document-request purposes and relevant document text. This may include sensitive personal or financial details. Your vault key and connector credentials are not sent to the model.",
  "Your approval is saved to your account before Azure is allowed. The pilot must also be enabled in this UAT environment. Without current approval, the pilot cannot send these private text requests to Azure. Voice and your own-key settings stay separate. This approval does not enable Bing search or Personal World Model research.",
  "You can revoke approval from One's model settings at any time. Revocation blocks new private Azure text requests; it cannot undo processing already sent. Your existing storage, sharing permissions and reviews remain in place.",
] as const;

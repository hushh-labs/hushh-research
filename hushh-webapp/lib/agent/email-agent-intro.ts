/**
 * The Gmail entry point queues this exactly as an ordinary first user message.
 * It starts a real Agent Chat turn; the delivery card remains the only explicit
 * owner action that can send the generated email.
 */
export function buildEmailAgentIntroPrompt(recipient: string): string {
  const normalizedRecipient = recipient.trim();
  return `Can you send an email to '${normalizedRecipient}', In the email explain features of the email agent.`;
}

/** Gmail's workspace opens One with a guided, owner-addressed draft request. */
export function buildGmailAgentHandoffPrompt(recipient: string): string {
  const normalizedRecipient = recipient.trim();
  if (!normalizedRecipient) {
    return "Help me prepare an email explaining the Gmail agent's features in detail. I want to review the draft before anything is sent.";
  }
  return `Send an email to '${normalizedRecipient}' explaining all the features of the Gmail agent in detail. Prepare the draft for my review and do not send it without my explicit approval.`;
}

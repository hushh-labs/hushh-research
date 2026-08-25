/**
 * The Gmail entry point queues this exactly as an ordinary first user message.
 * It starts a real Agent Chat turn; the delivery card remains the only explicit
 * owner action that can send the generated email.
 */
export function buildEmailAgentIntroPrompt(recipient: string): string {
  const normalizedRecipient = recipient.trim();
  return `Can you send an email to '${normalizedRecipient}', In the email explain features of the email agent.`;
}

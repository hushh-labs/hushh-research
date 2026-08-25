const EMAIL_AGENT_INTRO_SUBJECT = "Meet your Hushh Email Agent";

const EMAIL_AGENT_INTRO_BODY = `Hi,

I'm your Hushh Email Agent. I can help you draft clear emails, surface messages that may need attention, and use your Gmail context for receipts and inbox questions.

Every email stays editable and is only sent after your final approval.

— Hushh`;

/**
 * The first Email Agent handoff uses one review-first message for every
 * connected Gmail account. It is an instruction for One to draft, never an
 * authorization to send.
 */
export function buildEmailAgentIntroPrompt(recipient: string): string {
  const normalizedRecipient = recipient.trim();
  return `Draft this standard intro email to ${normalizedRecipient}. Do not send it; I will review it first.

To: ${normalizedRecipient}
Subject: ${EMAIL_AGENT_INTRO_SUBJECT}

Message:
${EMAIL_AGENT_INTRO_BODY}`;
}

export { EMAIL_AGENT_INTRO_BODY, EMAIL_AGENT_INTRO_SUBJECT };

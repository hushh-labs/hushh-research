/** Purpose copy only; connector owners retain all permission and action authority. */
export function connectorAccessPurpose(id: string): string {
  switch (id) {
    case "gmail": return "Find mail and help with replies, within the permissions you grant.";
    case "drive":
    case "google_drive": return "Use connected files to answer questions.";
    case "calendar": return "Use your calendar to help plan your time.";
    case "contacts": return "Use Google Contacts to help you find people.";
    case "plaid": return "Use connected accounts for Finance. Open to review or disconnect each bank.";
    default: return "Review what this app allows One to use.";
  }
}

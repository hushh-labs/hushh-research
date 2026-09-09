import { contactInvitationsEnabled } from "@/lib/contacts/invitation-candidates";

export function ContactInvitationNotice() {
  if (!contactInvitationsEnabled()) return null;
  return (
    <p className="mt-2 text-xs leading-5 text-muted-foreground">
      Sync reads contact names and numbers on your device. On web, available
      email addresses also help you prepare personal invitations. You choose
      each recipient before sharing; raw contact details are never uploaded to
      One.
    </p>
  );
}

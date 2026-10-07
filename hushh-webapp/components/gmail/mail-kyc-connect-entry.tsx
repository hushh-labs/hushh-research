"use client";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { KycAgentIcon } from "@/components/icons";

/**
 * Mail's KYC tab before Gmail is connected. A link that opens the tab directly
 * (`/one/gmail?workspace=kyc`, from a Memory item or a chat offer) lands here
 * instead of on the general Mail status card, so it is never a dead end: the
 * one control starts the same connection the status card would.
 *
 * Same block as Memory's "Open in <app>": the shared compact settings row on a
 * flat Morphy surface with the press ripple, the bare duotone registry glyph,
 * then a note 8 px below on the glyph's column.
 */
export function MailKycConnectEntry({
  busy = false,
  onConnect,
}: {
  busy?: boolean;
  onConnect: () => void;
}) {
  // One line at phone width, so the row keeps the shared compact geometry. It is
  // also right for an inbox whose permission was revoked: that reconnects
  // through the same consent.
  const title = "Connect Gmail to manage identity";
  return (
    <section aria-label="KYC" className="space-y-2" data-testid="mail-kyc-connect">
      <SettingsGroup separatorInset density="compact" testId="mail-kyc-connect-group">
        <SettingsRow
          icon={KycAgentIcon}
          iconTone="capability"
          density="compact"
          title={title}
          textOverflow="wrap"
          chevron
          disabled={busy}
          onClick={onConnect}
          testId="mail-kyc-connect-row"
          voiceControlId="open_gmail_connector"
          voiceLabel={title}
          voicePurpose="starts the Gmail connection so the KYC tab can find requests and manage identity details."
        />
      </SettingsGroup>
      <p className="px-4 text-[13px] leading-5 text-muted-foreground" data-testid="mail-kyc-connect-note">
        KYC requests arrive by email. Once Gmail is connected, One finds them
        here and drafts each reply from your identity details for you to review.
      </p>
    </section>
  );
}

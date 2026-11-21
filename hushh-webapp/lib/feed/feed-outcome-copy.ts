import { ROUTES, buildKaiMarketRoute } from "@/lib/navigation/routes";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { buildProfilePaneHref } from "@/lib/navigation/profile-pane";

export const AGENT_OUTCOME_COPY: Record<string, readonly [string, string, string]> = {
  calendar_action_failed: [
    "Calendar change needs review",
    "Check before retrying",
    ROUTES.CALENDAR,
  ],
  mail_mailbox_archive: [
    "Messages archived",
    "Your approved mailbox change finished.",
    ROUTES.GMAIL,
  ],
  mail_mailbox_trash: [
    "Messages moved to trash",
    "Your approved mailbox change finished.",
    ROUTES.GMAIL,
  ],
  mail_mailbox_add_label: [
    "Label added",
    "Your approved mailbox change finished.",
    ROUTES.GMAIL,
  ],
  mail_mailbox_remove_label: [
    "Label removed",
    "Your approved mailbox change finished.",
    ROUTES.GMAIL,
  ],
  mail_mailbox_mark_read: [
    "Messages marked as read",
    "Your approved mailbox change finished.",
    ROUTES.GMAIL,
  ],
  mail_mailbox_mark_unread: [
    "Messages marked as unread",
    "Your approved mailbox change finished.",
    ROUTES.GMAIL,
  ],
  mail_mailbox_failed: [
    "Mailbox change needs review",
    "Check changes before retrying",
    ROUTES.GMAIL,
  ],
  connected_systems_mutation_succeeded: [
    "App change completed",
    "Your approved change finished.",
    ROUTES.CONNECTED_SYSTEMS,
  ],
  connected_systems_mutation_partial: [
    "App change needs review",
    "Outcomes could not be confirmed; check before trying again.",
    ROUTES.CONNECTED_SYSTEMS,
  ],
  connected_systems_disconnected: [
    "App disconnected",
    "One no longer has access to this app.",
    ROUTES.CONNECTED_SYSTEMS,
  ],
  drive_search_completed: [
    "Drive search finished",
    "Return to your chat to review the search.",
    ROUTES.HOME,
  ],
  drive_search_limited: [
    "Drive search reached a limit",
    "Return to your chat to review the search limit.",
    ROUTES.HOME,
  ],
  drive_search_failed: [
    "Drive search needs another try",
    "Return to your chat to review or retry the search.",
    ROUTES.HOME,
  ],
  drive_search_stopped: [
    "Drive search stopped",
    "The search ended before completion.",
    ROUTES.HOME,
  ],
  drive_share_succeeded: [
    "Drive sharing completed",
    "",
    ROUTES.HOME,
  ],
  drive_share_failed: [
    "Drive sharing needs review",
    "Check before retrying",
    ROUTES.HOME,
  ],
  drive_share_unconfirmed: [
    "Drive sharing unconfirmed",
    "It may have succeeded; check before trying again.",
    ROUTES.HOME,
  ],
  drive_trash_succeeded: [
    "Drive file moved to trash",
    "",
    ROUTES.HOME,
  ],
  drive_trash_failed: [
    "Drive file change needs review",
    "Check before retrying",
    ROUTES.HOME,
  ],
  drive_trash_unconfirmed: [
    "Drive file change unconfirmed",
    "It may have succeeded; check before trying again.",
    ROUTES.HOME,
  ],
  drive_bulk_received: [
    "Drive files shared with you",
    "Open Profile to review files shared with you.",
    buildProfilePaneHref(ROUTES.ONE_HOME, null, {
      panel: "my-data",
      detail: null,
    }),
  ],
  drive_bulk_completed: [
    "Drive sharing finished",
    "",
    ROUTES.HOME,
  ],
  drive_bulk_partial: [
    "Drive sharing partly finished",
    "Outcomes could not be confirmed; check before trying again.",
    ROUTES.HOME,
  ],
  drive_bulk_failed: [
    "Drive sharing needs review",
    "Outcomes could not be confirmed; check before trying again.",
    ROUTES.HOME,
  ],
  drive_bulk_stopped: [
    "Drive sharing stopped",
    "Review shared files",
    ROUTES.HOME,
  ],
  kai_analysis_failed: [
    "Analysis could not finish",
    "Open Finance to start another analysis.",
    buildKaiMarketRoute("analysis"),
  ],
  kai_analysis_canceled: [
    "Analysis canceled",
    "The analysis ended before completion.",
    buildKaiMarketRoute("analysis"),
  ],
  kai_import_completed: [
    "Statement parsing finished",
    "Open Finance to check your current import.",
    ROUTES.KAI_IMPORT,
  ],
  kai_import_failed: [
    "Statement import could not finish",
    "Open Finance to import the statement again.",
    ROUTES.KAI_IMPORT,
  ],
  kai_import_canceled: [
    "Statement import canceled",
    "The import ended before completion.",
    ROUTES.KAI_IMPORT,
  ],
  consent_denied: [
    "Requested information declined",
    "",
    buildConsentCenterHref("previous"),
  ],
  consent_cancelled: [
    "Requested access withdrawn",
    "",
    buildConsentCenterHref("previous"),
  ],
  consent_timed_out: [
    "Requested access expired",
    "An unanswered part of this request expired.",
    buildConsentCenterHref("previous"),
  ],
};

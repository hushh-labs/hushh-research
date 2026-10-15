// Plain words for a file or packet request's error codes. Kept free of
// other imports so the Drive packet list (Connectors pane and a person's
// profile) can use them without loading the file request dialog.

export const IDENTITY_REQUIRED = new Set([
  "verify_google_identity_required",
  "google_identity_required",
]);

/** Plain words for a file or packet request that did not go through; `fallback` covers anything unknown. */
export function fileRequestError(
  code: string,
  fallback = "Couldn't confirm it was sent. Send again. It won't be sent twice.",
): string {
  if (IDENTITY_REQUIRED.has(code))
    return "Add a Google account once to receive original files.";
  switch (code) {
    case "identity_link_web_required":
      return "Open One on the web to add your Google account once.";
    case "identity_already_linked":
      return "That Google account belongs to another One account. Choose another.";
    case "identity_cancelled":
      return "Google verification was cancelled. No new request was sent.";
    case "identity_busy":
      return "Finish the verification already open, then retry.";
    case "identity_timeout":
      return "Google verification timed out. Close any open verification window, then retry.";
    case "identity_mismatch":
      return "Use the Google account linked to your One account.";
    case "native_identity_unavailable":
      return "Update the app to verify your Google account, then retry.";
    case "identity_popup_blocked":
      return "Allow the Google verification popup, then retry.";
    case "sharing_unavailable":
    case "connector_unavailable":
      return "File requests aren't available for this connection yet.";
    case "connection_required":
      return "You need an active connection with this person.";
    case "request_changed":
      return "This request was already sent with different details. Start a new request.";
    case "price_changed":
      return "The owner changed the price. Review the updated quote before sending.";
    case "date_range_required":
      return "Choose a start and end date.";
    default:
      return fallback;
  }
}

import type { OneLocationContactSignalResult } from "@/lib/one-location/contact-signals";

/** Saved Google contacts are a different source from the phone's address book. */
export function googleContactSyncSummary(
  result: OneLocationContactSignalResult,
) {
  if (result.sourcePlatform !== "google") return null;
  if (!result.partial && result.totalContacts === 0) {
    return {
      title: "No saved Google contacts found",
      description:
        "This Google account returned no saved contacts. Choose the account where your contacts are saved, or check Google Contacts. Contacts saved only on your phone are not included.",
    };
  }
  if (
    !result.partial &&
    result.readContactCount > 0 &&
    result.uncheckableContactCount === result.readContactCount
  ) {
    return {
      title: "No phone numbers to match",
      description:
        "Your Google contacts were read, but none had a usable phone number. One matches verified phone numbers. You can still invite contacts with an email address, or choose another Google account.",
    };
  }
  if (!result.partial && result.matches.length === 0) {
    return {
      title: "No matching One accounts found",
      description:
        "Your Google contacts were checked using their phone numbers. A match requires a verified number and a discoverable One account. You can invite eligible contacts below or try another Google account.",
    };
  }
  return null;
}

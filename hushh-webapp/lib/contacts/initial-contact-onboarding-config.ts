export const GOOGLE_CONTACTS_READ_SCOPE =
  "https://www.googleapis.com/auth/contacts.readonly";

export type InitialContactSource = "google" | "device" | "none";

/** Google cloud contacts for every Google signup, including native apps. */
export function initialContactSource(
  provider: "google" | "apple",
  native: boolean,
): Exclude<InitialContactSource, "none"> {
  return provider === "apple" && native ? "device" : "google";
}

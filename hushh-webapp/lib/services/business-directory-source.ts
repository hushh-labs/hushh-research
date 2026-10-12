/** Reserved demo sources also occur inside otherwise real directory envelopes. */
export function isDemoBusinessSource(sourceKey: string): boolean {
  try {
    const identity: unknown = JSON.parse(sourceKey);
    return Boolean(
      identity &&
      typeof identity === "object" &&
      "source" in identity &&
      ["uat_fixture", "uat_test"].includes(String(identity.source)),
    );
  } catch {
    return false;
  }
}

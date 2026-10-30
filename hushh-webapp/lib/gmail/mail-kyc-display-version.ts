// A doorbell version, never information or action authority.
const versions = new Map<string, number>();
export const mailKycDisplayVersion = (owner: string) => versions.get(owner) ?? 0;
export function advanceMailKycDisplayVersion(owner: string): void {
  versions.set(owner, mailKycDisplayVersion(owner) + 1);
}

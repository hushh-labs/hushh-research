/** Trusted account images travel encrypted; their bytes never become model context. */
export function isAnswerProfilePhotoScope(scope: string): boolean {
  return ["attr.identity.identity_profile.profile_photo_url", "attr.identity.identity_profile.photo_url"].includes(scope);
}

export function answerProfilePhotoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^data:image\/(png|jpe?g|webp);base64,/.test(text)) {
    if (text.length > 600_000) return null;
    const encoded = text.slice(text.indexOf(",") + 1);
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
    try { return atob(encoded).length <= 300 * 1024 ? text : null; } catch { return null; }
  }
  if (text.length > 4096) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function answerPhotoReference(url: string | null | undefined): string | null {
  return url ? "Profile photo included in the encrypted answer." : null;
}

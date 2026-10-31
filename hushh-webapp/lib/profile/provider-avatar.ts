/** Google Sign-In's documented FIFE avatar family, not arbitrary media URLs. */
export function googleAvatarSource(source: string): URL | null {
  try {
    const url = new URL(source);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      /^lh[3-6](?:-tt|-d[a-gz])?\.(?:google|googleusercontent)\.com$/.test(url.hostname) && /^\/a(?:-)?\//.test(url.pathname)
      ? url : null;
  } catch { return null; }
}

/** People API photo URLs use a different Google-hosted path from Sign-In avatars. */
export function googlePeoplePhotoSource(source: string): URL | null {
  if (source.length > 4096) return null;
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    if (!/^lh[3-6](?:-tt|-d[a-gz])?\.(?:google|googleusercontent)\.com$/.test(url.hostname)) return null;
    if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) return null;
    if ([...url.searchParams.keys()].some(key => key !== "sz")) return null;
    const size = url.searchParams.get("sz");
    if (size && !/^[1-9][0-9]{0,3}$/.test(size)) return null;
    return url;
  } catch { return null; }
}

export function providerAvatarAtSize(source: string | null, pixels = 768): string | null {
  if (!source) return null;
  const url = googleAvatarSource(source);
  if (!url) return source;
  const size = Math.min(1024, Math.max(64, Math.round(Number.isFinite(pixels) ? pixels : 768)));
  url.pathname = `${url.pathname.replace(/=.*$/, "")}=s${size}`;
  return url.href;
}

export function admittedPortraitSource(source: string): boolean {
  return source.length <= 410_000 && /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(source) ||
    source.length <= 4096 && googleAvatarSource(source) !== null;
}

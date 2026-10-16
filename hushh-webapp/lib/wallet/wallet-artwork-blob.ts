/** Convert approved decrypted bytes to a temporary display URL, never storage. */
export function createWalletArtworkBlobUrl(image: string): string {
  const match = image.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/);
  if (!match || image.length > 750_000) throw new Error("Card image unavailable.");
  const binary = atob(match[2]!);
  return URL.createObjectURL(new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: match[1] }));
}

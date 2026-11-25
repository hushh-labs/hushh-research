/** Private, in-memory Wallet display replicas. Card operations, authorisation
 * and encryption remain in the existing Wallet feature owners. No URLs, keys,
 * PANs or CVVs belong in the collection projection. */
export type NativeWalletTile = {
  id: string;
  kind: "payment" | "profile" | "referral" | "nws";
  title: string;
  subtitle: string;
  network: string;
  last4: string;
  holder: string;
  expiry: string;
  imageData?: string;
  overlayDetails?: boolean;
};
export type NativeWalletVisitor = { name: string; headline: string; organisation: string; location: string; summary: string; skills: readonly string[]; portraitData?: string };
export type NativeWalletCollection = {
  cards: readonly NativeWalletTile[];
  addId: string;
  addEnabled: boolean;
  accessId?: string;
  sharedTabId?: string;
  view?: "cards" | "sharing";
  selectedId: string | null;
  detailVisitId: string | null;
  closeId: string;
  detailTitle: string;
  detailBusy: boolean;
  detailQrData?: string;
  detailImageData?: string;
  navigation?: { sectionId: string; allId: string; previousId: string; nextId: string; addId: string; position: number; total: number };
  visitor?: NativeWalletVisitor;
};
const text = (value: unknown, maximum: number, empty = false): value is string =>
  typeof value === "string" && (empty || value.length > 0) && value.length <= maximum;
const closed = (value: object, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
export function validNativeWalletCollection(value: NativeWalletCollection): boolean {
  if (!value || !closed(value, ["cards", "addId", "addEnabled", "selectedId", "detailVisitId", "closeId", "detailTitle", "detailBusy", "detailQrData", "detailImageData", "accessId", "sharedTabId", "view", "navigation", "visitor"]) ||
    !text(value.addId, 128) || !text(value.closeId, 128) || value.addId === value.closeId ||
    typeof value.addEnabled !== "boolean" || typeof value.detailBusy !== "boolean" || !text(value.detailTitle, 256, true) ||
    value.sharedTabId !== undefined && !text(value.sharedTabId, 128) || value.view !== undefined && !["cards", "sharing"].includes(value.view) ||
    value.view === "sharing" && (value.selectedId !== null || value.detailVisitId !== null) ||
    !Array.isArray(value.cards) || value.cards.length > 100) return false;
  for (const image of [value.detailQrData, value.detailImageData]) if (image !== undefined && (typeof image !== "string" || image.length > 400_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(image))) return false;
  const ids = new Set([value.addId, value.closeId]);
  if (value.accessId !== undefined) { if (!text(value.accessId, 128) || ids.has(value.accessId)) return false; ids.add(value.accessId); }
  for (const card of value.cards) {
    if (!card || !closed(card, ["id", "kind", "title", "subtitle", "network", "last4", "holder", "expiry", "imageData", "overlayDetails"]) ||
      !text(card.id, 128) || ids.has(card.id) || !["payment", "profile", "referral", "nws"].includes(card.kind) ||
      !text(card.title, 256) || !text(card.subtitle, 256, true) || !text(card.network, 64, true) ||
      card.imageData !== undefined && (typeof card.imageData !== "string" || card.imageData.length > 400_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(card.imageData)) ||
      card.overlayDetails !== undefined && typeof card.overlayDetails !== "boolean" ||
      !text(card.holder, 120, true) || !text(card.expiry, 7, true) || !/^(?:\d{4})?$/.test(card.last4)) return false;
    ids.add(card.id);
  }
  if (value.visitor !== undefined) {
    const visitor = value.visitor;
    if (!visitor || !closed(visitor, ["name", "headline", "organisation", "location", "summary", "skills", "portraitData"]) || value.navigation ||
        !value.cards.some(card => card.id === value.selectedId && (card.kind === "profile" || card.kind === "nws")) ||
        ![visitor.name, visitor.headline, visitor.organisation, visitor.location].every(item => text(item, 512, true)) || !text(visitor.summary, 4096, true) ||
        !Array.isArray(visitor.skills) || visitor.skills.length > 64 || !visitor.skills.every((skill: unknown) => text(skill, 256)) ||
        visitor.portraitData !== undefined && (!text(visitor.portraitData, 100_000) || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(visitor.portraitData))) return false;
  }
  if (value.navigation !== undefined) {
    const nav = value.navigation;
    if (!nav || !closed(nav, ["sectionId", "allId", "previousId", "nextId", "addId", "position", "total"]) ||
        !value.selectedId || value.selectedId === value.accessId || value.view === "sharing" ||
        !Number.isInteger(nav.position) || !Number.isInteger(nav.total) || nav.total !== value.cards.length || nav.position < 1 || nav.position > nav.total) return false;
    const handles = [nav.sectionId, nav.allId, nav.previousId, nav.nextId, nav.addId];
    if (new Set(handles).size !== handles.length || handles.some(id => !text(id, 128) || ids.has(id))) return false;
  }
  return value.selectedId === null ? value.detailVisitId === null : text(value.detailVisitId, 128) && (value.selectedId === value.accessId || value.cards.some(card => card.id === value.selectedId));
}

/** Keep the existing native whole-message limit. Optional display artwork must
 * not retire a valid workspace when several individually valid images arrive.
 * Metadata and operations are never truncated. Swift escapes forward slashes;
 * reserve another 100 KB for serializer differences and envelope overhead. */
export function boundNativeWalletArtwork<T extends { wallet?: NativeWalletCollection }>(state: T): T {
  const source = state.wallet;
  if (!source) return state;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value).replaceAll("/", "\\/")).byteLength;
  const maximum = 900_000;
  if (bytes(state) <= maximum) return state;
  const cards = source.cards.map(({ imageData: _image, ...card }) => card);
  const { detailQrData: _qr, detailImageData: _image, ...metadata } = source;
  const wallet: NativeWalletCollection = { ...metadata, cards };
  const result = { ...state, wallet };
  let used = bytes(result);
  const admit = (key: string, data: string | undefined, apply: () => void) => {
    if (!data) return;
    const cost = bytes({ [key]: data }) + 1;
    if (used + cost > maximum) return;
    used += cost; apply();
  };
  // Preserve the selected QR and face ahead of offscreen thumbnails.
  admit("detailQrData", source.detailQrData, () => { wallet.detailQrData = source.detailQrData; });
  admit("detailImageData", source.detailImageData, () => { wallet.detailImageData = source.detailImageData; });
  const order = source.cards.map((card, index) => ({ card, index })).sort((a, b) => Number(b.card.id === source.selectedId) - Number(a.card.id === source.selectedId));
  for (const { card, index } of order) admit("imageData", card.imageData, () => { (cards[index] as NativeWalletTile).imageData = card.imageData; });
  return result;
}

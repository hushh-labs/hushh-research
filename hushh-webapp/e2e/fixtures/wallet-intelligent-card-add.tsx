import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SecureCardAddForm } from "../../components/wallet/secure-card-add-form";
import { WalletCardFace } from "../../components/wallet/wallet-card-face";
import { WalletSavedCardDetails } from "../../components/wallet/wallet-saved-card-details";
import { WalletService, type WalletCardPresentation } from "../../lib/services/wallet-service";
import { PersonalKnowledgeModelService as Pkm } from "../../lib/services/personal-knowledge-model-service";
import { decryptData } from "../../lib/vault/encrypt";
import { publishValidatedAuthSessionOwner } from "../../lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "../../lib/vault/session-epoch";
import { unwindBackLayer } from "../../lib/navigation/back-layers";
import { ApiService } from "./wallet-intelligent-boundaries";
const context = { userId: "scan-proof-owner", vaultOwnerToken: "synthetic-owner-token", vaultKey: "7f".repeat(32) };
publishValidatedAuthSessionOwner(context.userId);
// Replace only the encrypted read transport; writes use the real production
// storeDomainData wire allowlist, real segmentation, real crypto and real retry.
Pkm.loadDomainSnapshot = async () => {
  const record = await (await ApiService.apiFetch("/fixture/encrypted-record")).json();
  if (!record) return { data: null, snapshot: null };
  return { data: JSON.parse(await decryptData(record.encrypted_blob, context.vaultKey)), snapshot: {
    schemaVersion: "pkm_domain_snapshot.v1", userId: context.userId, domain: "wallet",
    encryptedBlob: record.encrypted_blob, contentRevision: record.revision, manifestRevision: record.revision,
    manifest: record.manifest, paths: record.manifest.paths, scopes: record.manifest.scopes,
    updatedAt: null, etag: String(record.revision), segmentIds: record.manifest.segment_ids,
  } };
};
Pkm.loadDomainData = async () => (await Pkm.loadDomainSnapshot({ ...context, domain: "wallet" })).data;
function Fixture() {
  const [cards, setCards] = useState<WalletCardPresentation[]>([]), [tab, setTab] = useState("add"), [locked, setLocked] = useState(false), [error, setError] = useState("");
  // Match the production Workspace: recover and decode artwork in one hydration.
  useEffect(() => { void WalletService.listCardPresentations(context, { recoverArtwork: true }).then(rows => { if (rows.length) { setCards(rows); setTab("cards"); } }).catch(() => setError("Read failed")); }, []);
  return <main className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
    <header className="flex items-center justify-between"><button className="min-h-11 px-3" onClick={() => { if (!unwindBackLayer("/one/wallet")) setTab("cards"); }}>Back</button><h1 className="text-lg font-semibold">Wallet</h1><button className="min-h-11 px-3" onClick={() => { advanceVaultSessionEpoch(); setCards([]); setLocked(true); }}>Lock Wallet</button></header>
    {locked ? <p>Wallet locked</p> : tab === "add" ? <SecureCardAddForm collectSecurityCode showIntroduction={false} scanInToolbar getNetworkContext={() => context} onCancel={() => setTab("cards")} onSubmit={async card => {
      await WalletService.addCard({ ...context, card, surface: "web", source: "one_wallet_add" });
      setCards(await WalletService.listCardPresentations(context, { recoverArtwork: true })); setTab("cards");
    }} /> : <section aria-label="Cards">{cards.map(row => <div key={row.summary.cardId} data-card-id={row.summary.cardId}><WalletCardFace {...row} />{new URLSearchParams(location.search).has("cvv-proof") ? <WalletSavedCardDetails card={row.summary} name={row.cardholderName} onCopyCardNumber={async () => false} onReadSecurityCode={() => WalletService.getCardSecurityCode({ ...context, cardId: row.summary.cardId })} onRemove={() => undefined} /> : null}<p className="text-sm">Added to Wallet</p></div>)}<button className="min-h-11 px-3" onClick={() => setTab("add")}>Add another card</button></section>}
    {error ? <p role="alert">{error}</p> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

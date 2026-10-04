import { createRoot } from "react-dom/client";
import { SecretItemsPanel, type SecretPanelItem } from "../../components/secrets/secret-items-panel";
import { SecretPlaceholderText } from "../../components/secrets/secret-placeholder-text";

/**
 * The secure Secrets card, every value synthetic. `?state=` picks kept,
 * revealed, locked or profile; nothing here touches the network or a vault.
 */
const ITEMS: SecretPanelItem[] = [
  { id: "sec_00000000000000a1", label: "openai API key ending 9f2a", kindLabel: "Key, token or password", offer: null, filedLabel: null },
  {
    id: "sec_00000000000000a2", label: "Visa card ending 1111", kindLabel: "Card number",
    offer: { fileTo: "wallet", actionLabel: "Add this card to Wallet" }, filedLabel: null,
  },
  {
    id: "sec_00000000000000a3", label: "Passport ending 4567", kindLabel: "ID number",
    offer: { fileTo: "kyc_identity_documents", actionLabel: "Add passport to Identity documents" }, filedLabel: null,
  },
];
const FAKE_VALUE = ["s", "k-proj-", "fakefake0000fakefake9f2a"].join("");

const state = new URLSearchParams(window.location.search).get("state") || "kept";
const noop = () => undefined;

function App() {
  const profile = state === "profile";
  return (
    <main className="mx-auto flex w-full max-w-[40rem] flex-col gap-4 px-4 py-6">
      <p className="self-end rounded-2xl bg-[color:var(--app-neutral-fill)] px-4 py-2.5 text-sm" data-testid="fixture-bubble">
        <SecretPlaceholderText text="Save these: ⟦secret:sec_00000000000000a1 openai API key ending 9f2a⟧ and ⟦secret:sec_00000000000000a2 Visa card ending 1111⟧" />
      </p>
      <SecretItemsPanel
        testId={profile ? "profile-secrets-list" : "secret-capture-card"}
        title={profile ? "Secrets" : "3 kept in Secrets"}
        description={profile
          ? "Keys, passwords and ID numbers you sent One. One knows them only by name; values open only here."
          : "One knows these only by name. Values stay encrypted in your vault and open only here."}
        items={profile ? [{ ...ITEMS[0]! }, { ...ITEMS[1]!, filedLabel: "Filed in Wallet" }, ITEMS[2]!] : ITEMS}
        revealed={state === "revealed" || profile ? { [ITEMS[0]!.id]: FAKE_VALUE } : {}}
        locked={state === "locked"}
        onReveal={noop}
        onHide={noop}
        onUnlock={noop}
        onOffer={noop}
        onRemove={profile ? noop : undefined}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

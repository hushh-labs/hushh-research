import React from "react";
import { createRoot } from "react-dom/client";
import { publishValidatedAuthSessionPrincipal } from "../../lib/auth/session-owner";
import type { User } from "firebase/auth";

import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { LostVaultDeletePanel } from "@/components/vault/lost-vault-delete-panel";

const root = document.getElementById("root")!;
const user = {
  uid: "setup-v10-visual-fixture",
  email: root.dataset.email ?? "you@one.example",
  providerData: [{ providerId: "password" }],
  getIdToken: async () => "visual-fixture-token",
} as User;

// The real vault flow requires an admitted application owner, including in layout fixtures.
publishValidatedAuthSessionPrincipal({ firebaseUid: "setup-v10-visual-fixture", ownerId: "setup-v10-visual-fixture", accountGeneration: 0 });

createRoot(root).render(
  root.dataset.flow === "delete" ? <LostVaultDeletePanel user={user} onBack={() => undefined} /> :
  <VaultUnlockDialog
    user={user}
    open
    dismissible={false}
    enableGeneratedDefault
    setupPresentation={root.dataset.flow !== "unlock"}
    title="Set a lock"
    description="Only you can open what you save."
    onSuccess={() => undefined}
  />,
);

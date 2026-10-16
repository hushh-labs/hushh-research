import React from "react";
import { createRoot } from "react-dom/client";
import type { User } from "firebase/auth";

import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";

const user = {
  uid: "setup-v10-visual-fixture",
  email: "you@one.example",
  providerData: [{ providerId: "password" }],
} as User;

createRoot(document.getElementById("root")!).render(
  <VaultUnlockDialog
    user={user}
    open
    dismissible={false}
    enableGeneratedDefault
    setupPresentation
    title="Set a lock"
    description="Only you can open what you save."
    onSuccess={() => undefined}
  />,
);

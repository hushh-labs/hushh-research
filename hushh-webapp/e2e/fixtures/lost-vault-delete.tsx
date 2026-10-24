import React from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../../lib/firebase/auth-context";
import { LostVaultDeletePanel } from "../../components/vault/lost-vault-delete-panel";
import LoginPage from "../../app/login/page";

function Journey() {
  const { user, loading } = useAuth();
  if (loading || !user) return <p role="status">Checking fixture session…</p>;
  return (
    <main className="mx-auto w-full max-w-lg pt-8">
      <LostVaultDeletePanel user={user} onBack={() => undefined} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  window.location.pathname === "/login" ? (
    <LoginPage />
  ) : (
    <AuthProvider>
      <Journey />
    </AuthProvider>
  ),
);

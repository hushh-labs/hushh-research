import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../../lib/firebase/auth-context";

function ProfileSignOut() {
  const { user, loading, signOut } = useAuth();
  // Mirrors VaultLockGuard: a settled anonymous state triggers a client-side
  // /login redirect that would compete with the terminal sign-out navigation.
  useEffect(() => {
    if (loading || user) return;
    void (window as unknown as { recordSignOutEvent: (event: string) => Promise<void> })
      .recordSignOutEvent("guard-login-redirect");
  }, [loading, user]);
  return <main>
    <h1>Profile</h1>
    <p>{loading ? "Signing out" : user ? "Connected" : "Signed out"}</p>
    <button disabled={loading || !user} onClick={() => void signOut()}>Sign out</button>
  </main>;
}

createRoot(document.getElementById("root")!).render(<AuthProvider><ProfileSignOut /></AuthProvider>);

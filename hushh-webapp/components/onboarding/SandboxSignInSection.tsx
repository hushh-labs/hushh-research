// SPDX-License-Identifier: Apache-2.0
"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import styles from "./AuthStepLight.module.css";

export function SandboxSignInSection({
  onSignIn,
}: {
  onSignIn: (email: string, password: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    form.reset();
    setBusy(true);
    setFailed(false);
    try {
      await onSignIn(String(fields.get("email")).trim(), String(fields.get("password")));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={styles.emailForm} aria-label="Team sandbox sign-in">
      <label htmlFor="sandbox-email" className={styles.emailLabel}>Sandbox email</label>
      <Input id="sandbox-email" name="email" type="email" autoComplete="username"
        className={styles.emailInput} required disabled={busy} />
      <label htmlFor="sandbox-password" className={styles.emailLabel}>Sandbox password</label>
      <Input id="sandbox-password" name="password" type="password" autoComplete="current-password"
        className={styles.emailInput} required disabled={busy} />
      <Button type="submit" className={styles.emailSubmit} disabled={busy}>
        {busy ? "Signing in…" : "Sign in to sandbox"}
      </Button>
      {failed ? <p role="alert">Sign-in failed. Check your sandbox credentials and try again.</p> : null}
    </form>
  );
}

import React from "react";
import { CopySnippet } from "@/components/app-ui/copy-snippet";

export default function DeveloperSettingsPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Developer Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your API keys, webhooks, and secure vault endpoints.</p>
      </div>

      <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-foreground">Production Vault Keys</h2>
          <p className="text-sm text-muted-foreground">
            These keys provide full access to your production KYC data. Keep them secure.
          </p>
        </div>
        
        <div className="flex flex-col gap-4 mt-2">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">Primary Publishable Key</label>
            <CopySnippet value="hushh_pub_key_884299" label="Publishable Key" />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">Secret Vault Key</label>
            <CopySnippet value="hushh_sec_key_9999Secure" label="Secret Vault Key" isSecret={true} />
          </div>
        </div>
      </section>
    </div>
  );
}
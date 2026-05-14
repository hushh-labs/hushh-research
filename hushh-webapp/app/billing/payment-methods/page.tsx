import React from "react";
import { CreditCardInput } from "@/components/app-ui/credit-card-input";
import { PCITrustBoundary } from "@/components/security/pci-trust-boundary";

export default function PaymentMethodsPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Billing & Payments</h1>
        <p className="text-sm text-muted-foreground">Manage your vaulted payment methods securely.</p>
      </div>

      <section>
        {/* The Explicit Security Boundary Requested by Maintainers */}
        <PCITrustBoundary securityOwner="Hushh-Vault-SecOps">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">Add New Card</label>
            <CreditCardInput />
          </div>
        </PCITrustBoundary>
      </section>
    </div>
  );
}
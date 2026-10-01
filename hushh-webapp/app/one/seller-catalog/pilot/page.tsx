"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AppPageContentRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  getSellerCatalogPilotPreview,
  type SellerCatalogPilotPreview,
} from "@/lib/services/seller-catalog-pilot-service";

export default function SellerCatalogPilotPage() {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const [preview, setPreview] = useState<SellerCatalogPilotPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);

  const refresh = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setLoading(true);
    setError(null);
    try {
      setPreview(await getSellerCatalogPilotPreview(vaultOwnerToken));
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : "The preview is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [vaultOwnerToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AppPageShell as="main" width="reading" className="pb-12">
      <AppPageContentRegion>
        <div className="space-y-6 py-6">
          <header className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Internal pilot</p>
            <h1 className="text-3xl font-semibold">Shopify catalog review</h1>
            <p className="text-sm text-muted-foreground">
              One shows selected Shopify records here for a private technical review.
              Nothing on this page publishes an item or sends a customer message.
            </p>
          </header>

          {!vaultOwnerToken && user ? (
            <div className="rounded-xl border p-5 space-y-3">
              <p>Unlock your private agent to open this review.</p>
              <button className="rounded-lg border px-4 py-2" onClick={() => setShowUnlock(true)}>
                Unlock One
              </button>
            </div>
          ) : null}

          {vaultOwnerToken ? (
            <div className="space-y-4">
              <button
                className="rounded-lg border px-4 py-2 disabled:opacity-50"
                disabled={loading}
                onClick={() => void refresh()}
              >
                {loading ? "Loading preview…" : "Refresh Shopify preview"}
              </button>
              {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
              {preview ? (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Source: {preview.shopDomain} · {preview.items.length} selected records · Private preview
                  </p>
                  {preview.items.map((item) => (
                    <article key={item.sourceProductId} className="rounded-xl border p-5 space-y-3">
                      <div>
                        <h2 className="text-lg font-semibold">{item.title || "Product unavailable"}</h2>
                        <p className="text-xs text-muted-foreground break-all">{item.sourceProductId}</p>
                      </div>
                      <p className="text-sm">
                        {item.state === "needs_seller_review"
                          ? "Seller review needed"
                          : item.state === "source_not_active"
                            ? "Source item is not active"
                            : "Source item is unavailable"}
                      </p>
                      {item.variants?.length ? (
                        <div className="space-y-2 text-sm">
                          {item.variants.map((variant) => (
                            <div key={variant.sourceVariantId} className="rounded-lg bg-muted/50 p-3">
                              <p>{variant.label || "Default configuration"}{variant.sku ? ` · ${variant.sku}` : ""}</p>
                              <p className="text-muted-foreground">
                                Shopify recorded {variant.recordedPrice} {item.currency}; inventory {variant.recordedInventory ?? "unknown"}.
                                Both need seller confirmation.
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </AppPageContentRegion>

      {user ? (
        <VaultUnlockDialog
          user={user}
          open={showUnlock}
          onOpenChange={setShowUnlock}
          title="Unlock your private agent"
          description="Open your vault to review the internal Shopify pilot."
          onSuccess={() => setShowUnlock(false)}
        />
      ) : null}
    </AppPageShell>
  );
}

import type { ScopeCommerceRequest } from "@/lib/services/scope-commerce-service";

export function CommerceTime({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return <div><dt data-consent-role="fact-label" className="text-muted-foreground">{label}</dt><dd data-consent-role="fact-value"><time dateTime={value}>{new Date(value).toLocaleString()}</time></dd></div>;
}

export function ScopeCommerceTimeline({ request }: { request: ScopeCommerceRequest }) {
  const purchase = request.purchase;
  return <dl data-consent-facts className="grid gap-3 text-sm sm:grid-cols-2">
    {!purchase ? <CommerceTime label="Respond by" value={request.request_deadline} /> : null}
    {purchase?.status === "reserved" ? <CommerceTime label="Share by" value={purchase.fulfillment_deadline} /> : null}
    {purchase?.status === "preparing" ? <CommerceTime label="Complete sharing by" value={purchase.activation_at} /> : null}
    <CommerceTime label="Access starts" value={purchase?.activation_at} />
    <CommerceTime label="Access ends" value={purchase?.expires_at} />
  </dl>;
}

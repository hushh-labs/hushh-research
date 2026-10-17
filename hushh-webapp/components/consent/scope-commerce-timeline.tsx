import type { ScopeCommerceRequest } from "@/lib/services/scope-commerce-service";

export function CommerceTime({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return <div><dt className="text-muted-foreground">{label}</dt><dd><time dateTime={value}>{new Date(value).toLocaleString()}</time></dd></div>;
}

export function ScopeCommerceTimeline({ request }: { request: ScopeCommerceRequest }) {
  const purchase = request.purchase;
  return <dl className="grid gap-3 text-sm sm:grid-cols-2">
    <CommerceTime label="Request deadline" value={request.request_deadline} />
    <CommerceTime label="Prepare by" value={purchase?.fulfillment_deadline} />
    <CommerceTime label="Scheduled access starts" value={purchase?.activation_at} />
    <CommerceTime label="Access ends / earnings mature" value={purchase?.expires_at} />
  </dl>;
}

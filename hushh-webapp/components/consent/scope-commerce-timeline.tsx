import type { ScopeCommerceRequest } from "@/lib/services/scope-commerce-service";
import { CheckCircle, CircleIcon, Clock } from "@/components/icons";
import { SEMANTIC_ROLE_CLASSES } from "@/lib/morphy-ux/tokens/semantic-roles";

export function CommerceTime({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return <div><dt data-consent-role="fact-label" className="text-muted-foreground">{label}</dt><dd data-consent-role="fact-value"><time dateTime={value}>{new Date(value).toLocaleString()}</time></dd></div>;
}

export function ScopeCommerceTimeline({ request }: { request: ScopeCommerceRequest }) {
  const purchase = request.purchase;
  const completed = ({ awaiting_payment: 1, reserved: 2, preparing: 2, staged: 3, armed: 3, active: 4 } as Record<string, number>)[purchase?.status ?? ""];
  return <>
    {completed !== undefined ? <ol key={purchase?.status} aria-label="Sharing progress" className="motion-step-enter mx-auto grid w-full max-w-md grid-cols-4 gap-2 py-2">
      {["Approved", "Funds held", "Ready", "Access"].map((label, index) => {
        const complete = index < completed;
        const Icon = complete ? CheckCircle : index === completed ? Clock : CircleIcon;
        return <li key={label} data-complete={String(complete)} aria-current={index === completed ? "step" : undefined} className="relative flex min-w-0 flex-col items-center gap-2 text-center">
          {index < 3 ? <span aria-hidden="true" className="pointer-events-none absolute left-[calc(50%_+_1rem)] top-4 h-px w-[calc(100%_-_2rem)] bg-border" /> : null}
          <span className="flex h-8 w-8 items-center justify-center"><Icon aria-hidden="true" className={`h-6 w-6 ${SEMANTIC_ROLE_CLASSES[complete ? "success" : "neutral"].glyph}`} /></span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </li>;
      })}
    </ol> : null}
    <dl data-consent-facts className="grid gap-3 text-sm sm:grid-cols-2">
    {!purchase ? <CommerceTime label="Respond by" value={request.request_deadline} /> : null}
    {purchase?.status === "reserved" ? <CommerceTime label="Share by" value={purchase.fulfillment_deadline} /> : null}
    {purchase?.status === "preparing" ? <CommerceTime label="Complete sharing by" value={purchase.activation_at} /> : null}
    <CommerceTime label="Access starts" value={purchase?.activation_at} />
    <CommerceTime label="Access ends" value={purchase?.expires_at} />
  </dl></>;
}

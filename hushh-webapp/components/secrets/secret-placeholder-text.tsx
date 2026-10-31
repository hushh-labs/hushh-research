import { LockedRowIcon } from "@/components/icons";
import { splitSecretPlaceholders } from "@/lib/pkm/secret-span-guard";

/**
 * A sent message as the person sees it: each `⟦secret:...⟧` placeholder drawn
 * as a small chip with its label. The value was never in this text.
 */
export function SecretPlaceholderText({ text }: { text: string }) {
  const parts = splitSecretPlaceholders(text);
  if (!parts.some((part) => part.kind === "secret")) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <span key={index}>{part.text}</span>
        ) : (
          <span
            key={index}
            data-testid="secret-placeholder-chip"
            className="mx-0.5 inline-flex items-center gap-1 rounded-md bg-[color:var(--app-neutral-fill)] px-1.5 align-baseline text-[0.9em] font-medium"
          >
            <LockedRowIcon size={14} aria-hidden="true" className="shrink-0" />
            <span>{part.label}</span>
          </span>
        ),
      )}
    </>
  );
}

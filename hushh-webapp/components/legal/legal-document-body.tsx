import type {
  LegalBlock,
  LegalDocument,
  LegalInline,
} from "@/lib/legal/legal-documents";

// One renderer for the Privacy Policy and Terms of Use, shared by the public
// /privacy and /terms pages and the inline sign-in sheet, so the text a
// person agrees to at sign-in is the same text the public page serves.

const linkClass =
  "font-medium text-[color:var(--app-accent)] underline underline-offset-2";

function isExternal(href: string): boolean {
  return /^https?:\/\//.test(href);
}

function Inline({ parts }: { parts: LegalInline[] }) {
  return (
    <>
      {parts.map((part, index) => {
        if (typeof part === "string") return <span key={index}>{part}</span>;
        return (
          <a
            key={index}
            className={linkClass}
            href={part.href}
            {...(isExternal(part.href)
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
          >
            {part.text}
          </a>
        );
      })}
    </>
  );
}

function Block({ block, compact }: { block: LegalBlock; compact: boolean }) {
  const text = compact
    ? "text-sm leading-6 text-muted-foreground"
    : "text-[16px] leading-7 text-[color:var(--app-secondary-label)]";
  if (block.kind === "p") {
    return (
      <p className={text}>
        <Inline parts={block.text} />
      </p>
    );
  }
  if (block.kind === "h") {
    return (
      <h3
        className={
          compact
            ? "pt-1 text-sm font-semibold text-foreground"
            : "pt-2 text-[17px] font-semibold leading-6 text-[color:var(--app-label)]"
        }
      >
        {block.text}
      </h3>
    );
  }
  return (
    <ul className={`list-disc space-y-2 pl-6 ${text}`}>
      {block.items.map((item, index) => (
        <li key={index}>
          <Inline parts={item} />
        </li>
      ))}
    </ul>
  );
}

export function LegalDocumentMeta({ doc }: { doc: LegalDocument }) {
  return (
    <>
      Effective {doc.lastUpdatedLabel} · Version {doc.version}
    </>
  );
}

export function LegalDocumentBody({
  doc,
  compact = false,
}: {
  doc: LegalDocument;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "space-y-5" : "space-y-10"}>
      {doc.sections.map((section) => (
        <section
          key={section.id}
          id={section.id}
          aria-labelledby={`${section.id}-title`}
          className={compact ? "space-y-2" : "scroll-mt-24 space-y-3"}
        >
          <h2
            id={`${section.id}-title`}
            className={
              compact
                ? "text-sm font-semibold text-foreground"
                : "text-[20px] font-semibold leading-7 text-[color:var(--app-label)]"
            }
          >
            {section.title}
          </h2>
          {section.blocks.map((block, index) => (
            <Block key={index} block={block} compact={compact} />
          ))}
        </section>
      ))}
    </div>
  );
}

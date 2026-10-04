"use client";

import Link from "next/link";
import type { MouseEvent } from "react";

import { ScrollText, ShieldCheck } from "@/components/icons";
import {
  SettingsGroup,
  SettingsPresentationProvider,
  SettingsRow,
} from "@/components/app-ui/settings-ui";
import {
  BodyText,
  Footnote,
  Headline,
  SectionTitle,
} from "@/components/app-ui/typography";
import {
  LEGAL_DOCUMENTS,
  type LegalBlock,
  type LegalDocumentType,
  type LegalInline,
} from "@/lib/legal/legal-documents";

/**
 * How the reader moves to the other legal document.
 *
 * - `route`: the public /terms and /privacy pages. The other document is its
 *   own address, opened by replacing this one so Back still leaves for where
 *   the person came from rather than bouncing between the two documents.
 * - `in-place`: Profile's Legal section. The other document opens inside the
 *   pane and the person never leaves Profile.
 */
export type LegalReaderNavigation =
  | { kind: "route" }
  | { kind: "in-place"; open: (type: LegalDocumentType) => void };

const LEGAL_ROUTE_TYPES: Record<string, LegalDocumentType> = {
  [LEGAL_DOCUMENTS.privacy.route]: "privacy",
  [LEGAL_DOCUMENTS.terms.route]: "terms",
};

const LINK_CLASSNAME =
  "font-medium text-[color:var(--app-accent)] underline underline-offset-2";

const LEGAL_ICONS: Record<LegalDocumentType, typeof ShieldCheck> = {
  privacy: ShieldCheck,
  terms: ScrollText,
};

function isExternal(href: string): boolean {
  return /^(https?:|mailto:)/.test(href);
}

function InlineLink({
  part,
  navigation,
}: {
  part: { text: string; href: string };
  navigation: LegalReaderNavigation;
}) {
  if (isExternal(part.href)) {
    return (
      <a
        className={LINK_CLASSNAME}
        href={part.href}
        {...(part.href.startsWith("mailto:")
          ? {}
          : { target: "_blank", rel: "noopener noreferrer" })}
      >
        {part.text}
      </a>
    );
  }
  const documentType = LEGAL_ROUTE_TYPES[part.href];
  if (documentType && navigation.kind === "in-place") {
    // A real address keeps a modified click (new tab) working; a plain click
    // swaps the document without leaving Profile.
    const open = (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      navigation.open(documentType);
    };
    return (
      <a className={LINK_CLASSNAME} href={part.href} onClick={open}>
        {part.text}
      </a>
    );
  }
  return (
    <Link
      className={LINK_CLASSNAME}
      href={part.href}
      replace={Boolean(documentType)}
    >
      {part.text}
    </Link>
  );
}

function Inline({
  parts,
  navigation,
}: {
  parts: LegalInline[];
  navigation: LegalReaderNavigation;
}) {
  return (
    <>
      {parts.map((part, index) =>
        typeof part === "string" ? (
          <span key={index}>{part}</span>
        ) : (
          <InlineLink key={index} part={part} navigation={navigation} />
        ),
      )}
    </>
  );
}

function Block({
  block,
  navigation,
}: {
  block: LegalBlock;
  navigation: LegalReaderNavigation;
}) {
  if (block.kind === "p") {
    return (
      <BodyText>
        <Inline parts={block.text} navigation={navigation} />
      </BodyText>
    );
  }
  if (block.kind === "h") {
    return <Headline className="pt-2">{block.text}</Headline>;
  }
  return (
    <ul className="flex list-disc flex-col gap-2 pl-6">
      {block.items.map((item, index) => (
        <BodyText as="li" key={index}>
          <Inline parts={item} navigation={navigation} />
        </BodyText>
      ))}
    </ul>
  );
}

function scrollToSection(sectionId: string) {
  const target = document.getElementById(sectionId);
  if (!target) return;
  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({
    block: "start",
    behavior: reduceMotion ? "auto" : "smooth",
  });
}

/**
 * The one reader for the Privacy Policy and Terms of Use, used by the public
 * /privacy and /terms pages and by Profile's Legal section, so the text a
 * person reads is the same everywhere and is laid out the same way.
 *
 * It renders inside its host's page header (title and summary), so it starts
 * at the effective date. Type comes from the app's semantic roles and the
 * surfaces are the shared grouped rows, so it reads like every other screen.
 */
export function LegalReader({
  type,
  navigation,
  anchorOffset = "16px",
}: {
  type: LegalDocumentType;
  navigation: LegalReaderNavigation;
  /**
   * How far below the host's top edge a section lands when chosen from
   * "On this page". The public page clears the app's top bar; the Profile
   * pane's header sits outside its scroll area.
   */
  anchorOffset?: string;
}) {
  const doc = LEGAL_DOCUMENTS[type];
  const otherType: LegalDocumentType = type === "privacy" ? "terms" : "privacy";
  const other = LEGAL_DOCUMENTS[otherType];

  // Compact rows in both hosts, matching Profile, so the contents list and
  // See also read the same on the public page as in the pane.
  return (
    <SettingsPresentationProvider density="compact">
      <article
        className="flex min-w-0 flex-col gap-8"
        data-testid={`legal-reader-${type}`}
        data-legal-document={type}
      >
        <Footnote data-testid="legal-reader-meta">
          Effective {doc.lastUpdatedLabel} · Version {doc.version}
        </Footnote>

        <SettingsGroup title="On this page" testId="legal-reader-contents">
          {doc.sections.map((section) => (
            <SettingsRow
              key={section.id}
              title={section.title}
              onClick={() => scrollToSection(section.id)}
              testId={`legal-reader-contents-${section.id}`}
            />
          ))}
        </SettingsGroup>

        <div className="flex flex-col gap-8" data-testid="legal-reader-body">
          {doc.sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              aria-labelledby={`${section.id}-title`}
              className="flex flex-col gap-3"
              style={{ scrollMarginTop: anchorOffset }}
            >
              <SectionTitle id={`${section.id}-title`}>
                {section.title}
              </SectionTitle>
              {section.blocks.map((block, index) => (
                <Block key={index} block={block} navigation={navigation} />
              ))}
            </section>
          ))}
        </div>

        <SettingsGroup title="See also" testId="legal-reader-see-also">
          {navigation.kind === "in-place" ? (
            <SettingsRow
              icon={LEGAL_ICONS[otherType]}
              iconTone="capability"
              title={other.title}
              chevron
              onClick={() => navigation.open(otherType)}
              testId={`legal-reader-open-${otherType}`}
            />
          ) : (
            <SettingsRow
              asChild
              icon={LEGAL_ICONS[otherType]}
              iconTone="capability"
              title={other.title}
              chevron
              testId={`legal-reader-open-${otherType}`}
            >
              <Link href={other.route} replace />
            </SettingsRow>
          )}
        </SettingsGroup>
      </article>
    </SettingsPresentationProvider>
  );
}

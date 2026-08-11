"use client";

import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CaptionText,
  PageSubtitle,
  RowDescription,
} from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";

/**
 * The presentational parts every "near you" directory shares.
 *
 * Three directories now hang off the Connect tab — advisers from BrokerCheck,
 * insurance agencies from the Nationwide locator, and businesses from Google
 * Places — and they ask the reader for exactly the same things: permission to
 * use location, a ZIP when that fails, a way out of an empty result, and the
 * source credit. Only the copy and the test ids differ, so those are props and
 * the behaviour is written once.
 *
 * `testId` is threaded through rather than derived so each directory keeps its
 * own stable hooks; a shared "directory-empty" would make a failing test
 * ambiguous about which surface broke.
 */

/** The credit block both directories render, in the shape each one supplies. */
export type DirectoryAttribution = {
  source: string;
  sourceUrl: string;
  notice: string;
  termsUrl?: string | null;
  errorReporting?: string | null;
  retrievedAt: string;
};

export function DirectoryLoadingRows({ testId }: { testId: string }) {
  return (
    <div className="space-y-3 px-1 py-2" data-testid={testId}>
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-11 w-full rounded-xl" />
      ))}
    </div>
  );
}

/**
 * The one way in when coordinates cannot answer the question — location was
 * refused, or the coordinates are real but the directory covers nobody there.
 *
 * The label is a prop because the three directories do not share a geography.
 * BrokerCheck and the Nationwide locator are US registers, so "ZIP" is the
 * honest word there and anyone outside the US has working GPS and an empty
 * list. Places is worldwide, so calling its input a ZIP tells a reader in
 * Bengaluru or Berlin that the surface is not for them, which is false. The
 * default stays "ZIP" so the two US directories are untouched.
 */
export function PostalCodeForm({
  busy,
  initialValue = "",
  onSearch,
  testId,
  label = "ZIP",
  numericOnly = true,
}: {
  busy: boolean;
  initialValue?: string;
  onSearch: (postalCode: string) => void;
  testId: string;
  /** Shown as placeholder and accessible name. "ZIP" for US-only directories. */
  label?: string;
  /** US and Indian codes are digits; UK and Canadian ones are not. */
  numericOnly?: boolean;
}) {
  const [postalCode, setPostalCode] = useState(initialValue);

  return (
    <form
      className="flex w-full gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = postalCode.trim();
        if (trimmed) onSearch(trimmed);
      }}
    >
      <Input
        value={postalCode}
        onChange={(event) => setPostalCode(event.target.value)}
        placeholder={label}
        inputMode={numericOnly ? "numeric" : "text"}
        aria-label={label}
        className="h-11"
        data-testid={testId}
      />
      <Button
        type="submit"
        variant="none"
        effect="fill"
        size="lg"
        disabled={busy || !postalCode.trim()}
      >
        Search
      </Button>
    </form>
  );
}

/**
 * The source credit a directory's terms require wherever its data is shown.
 *
 * BrokerCheck's Terms §5 require four things — the source named, BrokerCheck
 * and its Terms linked, and a way to report an error. The Nationwide locator
 * supplies only a source and a link. Both optional links are therefore rendered
 * only when the source actually provides them: a link with no href is not a
 * weaker credit, it is a broken one.
 */
export function DirectoryAttributionFooter({
  attribution,
  stale,
  testId,
}: {
  attribution: DirectoryAttribution | null;
  stale: boolean;
  testId: string;
}) {
  if (!attribution) return null;

  const retrieved = attribution.retrievedAt
    ? new Date(attribution.retrievedAt)
    : null;
  const retrievedLabel =
    retrieved && !Number.isNaN(retrieved.getTime())
      ? retrieved.toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : null;

  return (
    <footer className="mx-auto max-w-[30rem] text-center" data-testid={testId}>
      <CaptionText as="p">
        <a
          href={attribution.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="underline-offset-4 hover:underline"
        >
          {attribution.source}
        </a>
        {attribution.termsUrl ? (
          <>
            {" · "}
            <a
              href={attribution.termsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="underline-offset-4 hover:underline"
            >
              Terms
            </a>
          </>
        ) : null}
        {attribution.errorReporting ? (
          <>
            {" · "}
            <a
              href={attribution.errorReporting}
              target="_blank"
              rel="noreferrer noopener"
              className="underline-offset-4 hover:underline"
            >
              Report an error
            </a>
          </>
        ) : null}
      </CaptionText>
      {retrievedLabel ? (
        <CaptionText as="p" className="mt-1">
          Retrieved {retrievedLabel}
          {stale ? " · cached" : ""}
        </CaptionText>
      ) : null}
    </footer>
  );
}

/** A centred non-result: one line, and the single thing worth doing next. */
export function QuietBlock({
  title,
  subtitle,
  testId,
  children,
}: {
  title: string;
  subtitle?: string;
  testId: string;
  children?: React.ReactNode;
}) {
  return (
    <section
      className="mx-auto flex w-full max-w-[26rem] flex-col items-center py-12 text-center"
      data-testid={testId}
    >
      <h2 className="type-title3 text-foreground">{title}</h2>
      {subtitle ? (
        <PageSubtitle className="mt-2">{subtitle}</PageSubtitle>
      ) : null}
      {children ? <div className="mt-6 w-full">{children}</div> : null}
    </section>
  );
}

/** One calm block: why we need location, and the single tap that grants it. */
export function LocationPrompt({
  denied,
  busy,
  heading,
  onUseLocation,
  onSearchPostalCode,
  testId,
  useLocationTestId,
  postalInputTestId,
  postalLabel = "ZIP",
  postalNumericOnly = true,
}: {
  denied: boolean;
  busy: boolean;
  /** Shown when location has not been refused — "Advisors near you". */
  heading: string;
  onUseLocation: () => void;
  onSearchPostalCode: (postalCode: string) => void;
  testId: string;
  useLocationTestId: string;
  postalInputTestId: string;
  /** See PostalCodeForm: "ZIP" is only honest for the two US registers. */
  postalLabel?: string;
  postalNumericOnly?: boolean;
}) {
  const [showPostal, setShowPostal] = useState(denied);

  useEffect(() => {
    if (denied) setShowPostal(true);
  }, [denied]);

  return (
    <section
      className="mx-auto flex w-full max-w-[26rem] flex-col items-center py-14 text-center"
      data-testid={testId}
    >
      <h2 className="type-title2 text-foreground">
        {denied ? "Location is off" : heading}
      </h2>
      <PageSubtitle className="mt-2">
        {denied ? `Search by ${postalLabel.toLowerCase()} instead.` : "See who's close by."}
      </PageSubtitle>

      {denied ? null : (
        <Button
          type="button"
          variant="blue-gradient"
          effect="fill"
          size="lg"
          fullWidth
          className="mt-8"
          disabled={busy}
          onClick={onUseLocation}
          data-testid={useLocationTestId}
        >
          {busy ? "Locating…" : "Use location"}
        </Button>
      )}

      {showPostal ? (
        <div className="mt-6 w-full">
          <PostalCodeForm
            busy={busy}
            onSearch={onSearchPostalCode}
            testId={postalInputTestId}
            label={postalLabel}
            numericOnly={postalNumericOnly}
          />
        </div>
      ) : (
        <Button
          type="button"
          variant="none"
          effect="fade"
          size="sm"
          className="mt-3"
          onClick={() => setShowPostal(true)}
        >
          <RowDescription>Use a ZIP</RowDescription>
        </Button>
      )}
    </section>
  );
}

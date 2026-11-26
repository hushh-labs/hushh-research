export type FinancePortfolioSourceDetails =
  | { kind: "plaid" }
  | { kind: "statement"; fileName: string | null; importedAt: string | null };

export function PortfolioSourceDetails({ source }: { source: FinancePortfolioSourceDetails | null }) {
  if (!source) return <p>No portfolio source available.</p>;
  if (source.kind === "plaid") return <p>Linked Plaid account</p>;

  const { fileName, importedAt } = source;
  const uploadedAt = importedAt && Number.isFinite(Date.parse(importedAt))
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        ...(/T\d{2}:\d{2}/i.test(importedAt) ? { timeStyle: "short" } : { timeZone: "UTC" }),
      }).format(new Date(importedAt))
    : null;
  return (
    <div className="space-y-1">
      <p className="break-words ui-text-row-label-emphasized">{fileName || "Statement name unavailable"}</p>
      {uploadedAt && importedAt ? (
        <p className="ui-text-row-description text-muted-foreground">
          Imported <time dateTime={importedAt}>{uploadedAt}</time>
        </p>
      ) : null}
    </div>
  );
}

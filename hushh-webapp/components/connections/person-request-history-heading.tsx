"use client";
/** Request history preserves the exact purpose and existing local date presentation. */
export function PersonRequestHistoryHeading({ title, requestPurpose, createdAt }: {
  title: string; requestPurpose: string; createdAt: number | string | null | undefined;
}) {
  return (
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold">{title}</p>
                            <p className="mt-1 text-sm text-muted-foreground">{requestPurpose}</p>
                            {createdAt ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(createdAt))}
                              </p>
                            ) : null}
                          </div>
  );
}

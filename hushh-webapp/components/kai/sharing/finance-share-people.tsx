"use client";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { openPersonProfilePreview } from "@/lib/connections/person-profile-preview";
import { SectionLabel } from "@/components/app-ui/typography";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Input } from "@/components/ui/input";
import type {
  FinanceShareFlowModel,
  FinanceShareUpdate,
} from "./use-finance-share-flow";
import styles from "./finance-sharing.module.css";
export function FinanceSharePeople({
  flow,
  initialShare,
}: {
  flow: FinanceShareFlowModel;
  initialShare?: FinanceShareUpdate;
}) {
  const {
    selected,
    setSelected,
    query,
    setQuery,
    people,
    peopleBusy,
    more,
    setPage,
    tabSetId,
    peopleHeading,
  } = flow;
  const title = "Who can see it?",
    id = `top-shell-${tabSetId}-tab-people`,
    headingRef = peopleHeading;
  return (
    <section
      className={`${styles.group} ${styles.peopleGroup}`}
      data-testid="finance-share-people"
    >
      <SectionLabel
        id={id}
        ref={headingRef}
        tabIndex={headingRef ? -1 : undefined}
        role="heading"
        aria-level={2}
        className={styles.heading}
      >
        {title}
      </SectionLabel>
      {selected.length && !initialShare ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {selected.map((person) => (
            <button
              className={styles.chip}
              key={person.userId}
              onClick={() =>
                setSelected((p) => p.filter((r) => r.userId !== person.userId))
              }
              aria-label={`Remove ${person.displayName}`}
            >
              {person.displayName} ×
            </button>
          ))}
        </div>
      ) : null}
      {!initialShare ? (
        <label className="mt-4 block">
          <span className="sr-only">Search connections</span>
          <Input
            value={query}
            placeholder="Search your connections"
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </label>
      ) : null}
      <div
        className={styles.recipientList}
        aria-label="Connections"
        role="group"
        aria-busy={peopleBusy}
      >
        {people.map((person) => (
          <label key={person.userId} className={styles.choice}>
            <input
              type="checkbox"
              aria-label={`${person.displayName}${person.isFinanceAdvisor ? ", verified advisor" : ""}`}
              disabled={
                Boolean(initialShare) ||
                !person.keyId ||
                !person.publicKeyJwk ||
                (!selected.some((r) => r.userId === person.userId) &&
                  selected.length >= 20)
              }
              checked={selected.some((r) => r.userId === person.userId)}
              onChange={(e) =>
                setSelected((p) =>
                  e.target.checked
                    ? [...p, person]
                    : p.filter((r) => r.userId !== person.userId),
                )
              }
            />
            <ConnectionPersonAvatar
              label={person.displayName}
              photoUrl={person.photoUrl}
              verified={person.isFinanceAdvisor}
              size="compact"
            />
            <span>
              <button
                type="button"
                className="text-left"
                aria-label={`View ${person.displayName}'s profile`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openPersonProfilePreview(
                    { userId: person.userId },
                    event.currentTarget,
                  );
                }}
              >
                {person.displayName}
              </button>
              {person.keyId && person.publicKeyJwk ? null : (
                <small>Needs to unlock One first</small>
              )}
            </span>
          </label>
        ))}
        {!peopleBusy && !people.length ? (
          <p className="py-4 text-sm text-muted-foreground">
            No matching connections. People with access are in Manage sharing.
          </p>
        ) : null}
        {peopleBusy ? (
          <p role="status" className={styles.caption}>
            Checking connections…
          </p>
        ) : null}
        {more ? (
          <ShellActionSurface
            variant="pill"
            disabled={peopleBusy}
            onClick={() => setPage((p) => p + 1)}
          >
            More connections
          </ShellActionSurface>
        ) : null}
      </div>
    </section>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { advisorRequest } from "@/lib/advisor-review/service";
import type { AdvisorCandidate } from "@/lib/advisor-review/contract";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { SegmentedTabs } from "@/lib/morphy-ux/ui";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import type { AdvisorSearchResult } from "@/lib/services/advisor-directory-service";
import styles from "./advisor-review.module.css";

type Result = {
  items: AdvisorCandidate[];
  directory: AdvisorSearchResult | null;
  hasMore: boolean;
};
type Search =
  | { scope: "connections" }
  | { scope: "global"; query: string }
  | ({ scope: "nearby"; radiusMiles: number } & (
      { postalCode: string } | { latitude: number; longitude: number }
    ));
const connections: Search = { scope: "connections" };

export function AdvisorDiscovery({
  context,
  onChoose,
}: {
  context: FinanceShareContext;
  onChoose: (person: AdvisorCandidate) => void;
}) {
  const [tab, setTab] = useState<"connections" | "nearby">("connections");
  const [query, setQuery] = useState("");
  const [postalCode, setPostal] = useState("");
  const [radius, setRadius] = useState("5");
  const [result, setResult] = useState<
    (Result & { search: Search; page: number }) | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const run = useRef(0);
  useEffect(() => {
    active.current = true;
    run.current++;
    return () => {
      active.current = false;
    };
  }, []);
  const search = useCallback(
    async (criteria: Search, page = 1) => {
      const version = ++run.current;
      setBusy(true);
      setError(null);
      if (page === 1) setResult(null);
      try {
        const value = await advisorRequest<Result>(
          context,
          "/candidates",
          "POST",
          { ...criteria, page },
        );
        if (active.current && context.isCurrent() && run.current === version) {
          setResult((previous) => ({
            ...value,
            items:
              page === 1
                ? value.items
                : [
                    ...(previous?.items ?? []),
                    ...value.items.filter(
                      (person) =>
                        !previous?.items.some(
                          (existing) => existing.personRef === person.personRef,
                        ),
                    ),
                  ],
            search: criteria,
            page,
          }));
        }
      } catch (e) {
        if (active.current && context.isCurrent() && run.current === version) {
          setError(
            e instanceof Error ? e.message : "Advisor search is unavailable.",
          );
        }
      } finally {
        if (active.current && run.current === version) setBusy(false);
      }
    },
    [context],
  );
  useEffect(() => {
    void search(connections);
  }, [search]);
  const browse = (next: "connections" | "nearby") => {
    run.current++;
    setTab(next);
    setQuery("");
    setResult(null);
    setError(null);
    setBusy(false);
    if (next === "connections") void search(connections);
  };
  const locate = () => {
    if (!navigator.geolocation) {
      setError(
        "Location is unavailable. Enter a postal code instead.",
      );
      return;
    }
    const version = ++run.current;
    setBusy(true);
    setError(null);
    setResult(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (active.current && context.isCurrent() && run.current === version)
          void search({
            scope: "nearby",
            radiusMiles: Number(radius),
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
      },
      () => {
        if (active.current && run.current === version) {
          setBusy(false);
          setError(
            "Location was not available. Enter a postal code instead.",
          );
        }
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };
  return (
    <div className={styles.stack}>
      <div>
        <h3 className="ui-text-section-label">Find an advisor</h3>
        <p className="ui-text-helper-text">
          Only verified advisors with a Hussh account can receive a secure
          request here.
        </p>
      </div>
      <form
        className={styles.row}
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim())
            void search({ scope: "global", query: query.trim() });
        }}
      >
        <Input
          aria-label="Advisor name"
          placeholder="Search all verified RIAs"
          maxLength={100}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ShellActionSurface
          type="submit"
          variant="pill"
          disabled={!query.trim()}
        >
          Search
        </ShellActionSurface>
      </form>
      <SegmentedTabs
        value={tab}
        options={[
          { value: "connections", label: "My Connections" },
          { value: "nearby", label: "Nearby" },
        ]}
        onValueChange={(value) =>
          browse(value === "nearby" ? "nearby" : "connections")
        }
      />
      {result?.search.scope === "global" ? (
        <div className={styles.row}>
          <h4 className="ui-text-section-label">Search results · all areas</h4>
          <ShellActionSurface variant="pill" onClick={() => browse(tab)}>
            Clear search
          </ShellActionSurface>
        </div>
      ) : tab === "nearby" ? (
        <>
          <form
            className={styles.row}
            onSubmit={(event) => {
              event.preventDefault();
              const postal = postalCode.trim();
              if (postal.length >= 3)
                void search({
                  scope: "nearby",
                  postalCode: postal,
                  radiusMiles: Number(radius),
                });
            }}
          >
            <Input
              aria-label="Postal code"
              placeholder="Postal code"
              maxLength={12}
              value={postalCode}
              onChange={(event) => setPostal(event.target.value)}
            />
            <select
              aria-label="Search radius"
              value={radius}
              onChange={(event) => setRadius(event.target.value)}
            >
              <option value="0.24855">400 m</option>
              <option value="0.621371">1 km</option>
              <option value="5">5 miles</option>
              <option value="25">25 miles</option>
            </select>
            <ShellActionSurface
              type="submit"
              variant="pill"
              disabled={busy || postalCode.trim().length < 3}
            >
              Search nearby
            </ShellActionSurface>
          </form>
          <ShellActionSurface variant="pill" disabled={busy} onClick={locate}>
            Use my location
          </ShellActionSurface>
        </>
      ) : null}
      {busy ? <p role="status">Finding advisors…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {result?.items.map((person) => (
        <div className={styles.person} key={person.personRef}>
          <div>
            <div className={styles.row}>
              <ConnectionPersonAvatar
                label={person.name}
                personRef={person.personRef}
                verified
                size="comfortable"
              />
              <strong>{person.name}</strong>
            </div>
            <p className="ui-text-helper-text">
              {person.bio || "Verified advisor"}
            </p>
            {!person.ready ? (
              <p className="ui-text-helper-text">
                This advisor needs to unlock One to enable secure requests.
              </p>
            ) : null}
          </div>
          <ShellActionSurface
            variant="pill"
            disabled={!person.ready || busy}
            onClick={() => onChoose(person)}
          >
            Choose
          </ShellActionSurface>
        </div>
      ))}
      {result && !busy && !result.items.length ? (
        <p>
          {result.search.scope === "connections"
            ? "No verified advisors on this page of your connections. Try Nearby or search by name."
            : "No eligible advisors found on this page."}
        </p>
      ) : null}
      {result?.hasMore ? (
        <ShellActionSurface
          variant="pill"
          disabled={busy}
          onClick={() => void search(result.search, result.page + 1)}
        >
          Load more advisors
        </ShellActionSurface>
      ) : null}
      {result?.directory ? (
        <div className={styles.notice}>
          <p className="ui-text-helper-text">
            Office distances are approximate.{" "}
            {result.directory.meta.radiusAdjusted
              ? "The directory adjusted the requested radius."
              : ""}{" "}
            Directory-only profiles cannot receive an in-app request.
          </p>
          <a
            href={result.directory.attribution.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            {result.directory.attribution.source}
          </a>
          <span> · </span>
          <a
            href={result.directory.attribution.termsUrl}
            target="_blank"
            rel="noreferrer"
          >
            Directory terms
          </a>
          <p className="ui-text-caption">
            {result.directory.attribution.notice}{" "}
            {result.directory.attribution.errorReporting} Retrieved{" "}
            {result.directory.attribution.retrievedAt}.
          </p>
        </div>
      ) : null}
    </div>
  );
}

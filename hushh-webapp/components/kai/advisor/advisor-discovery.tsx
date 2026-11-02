"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { advisorRequest } from "@/lib/advisor-review/service";
import type { AdvisorCandidate } from "@/lib/advisor-review/contract";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import type { AdvisorSearchResult } from "@/lib/services/advisor-directory-service";
import styles from "./advisor-review.module.css";

type Result = {
  items: AdvisorCandidate[];
  directory: AdvisorSearchResult | null;
};
export function AdvisorDiscovery({
  context,
  onChoose,
}: {
  context: FinanceShareContext;
  onChoose: (person: AdvisorCandidate) => void;
}) {
  const [query, setQuery] = useState("");
  const [postalCode, setPostal] = useState("");
  const [radius, setRadius] = useState("5");
  const [result, setResult] = useState<Result | null>(null);
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
  const search = async (nearby: boolean, point?: GeolocationCoordinates) => {
    const version = ++run.current;
    setBusy(true);
    setError(null);
    try {
      const value = await advisorRequest<Result>(
        context,
        "/candidates",
        "POST",
        nearby
          ? {
              ...(point
                ? { latitude: point.latitude, longitude: point.longitude }
                : { postalCode: postalCode.trim() }),
              radiusMiles: Number(radius),
            }
          : { query: query.trim() },
      );
      if (active.current && context.isCurrent() && run.current === version)
        setResult(value);
    } catch (e) {
      if (active.current && context.isCurrent() && run.current === version) {
        setResult(null);
        setError(
          e instanceof Error ? e.message : "Advisor search is unavailable.",
        );
      }
    } finally {
      if (active.current && run.current === version) setBusy(false);
    }
  };
  useEffect(() => {
    void search(false); /* One deliberate directory load per unlocked visit. */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);
  const locate = () => {
    if (!navigator.geolocation) {
      setError(
        "Location is unavailable. Enter an area or postal code instead.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (active.current && context.isCurrent())
          void search(true, position.coords);
      },
      () => {
        if (active.current) {
          setBusy(false);
          setError(
            "Location was not available. Enter an area or postal code instead.",
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
          void search(false);
        }}
      >
        <Input
          aria-label="Advisor name"
          placeholder="Search verified advisors"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ShellActionSurface type="submit" variant="pill" disabled={busy}>
          Search
        </ShellActionSurface>
      </form>
      <form
        className={styles.row}
        onSubmit={(e) => {
          e.preventDefault();
          void search(true);
        }}
      >
        <Input
          aria-label="Area or postal code"
          placeholder="Area or postal code"
          value={postalCode}
          onChange={(e) => setPostal(e.target.value)}
        />
        <select
          aria-label="Search radius"
          value={radius}
          onChange={(e) => setRadius(e.target.value)}
        >
          <option value="0.24855">400 m</option>
          <option value="0.621371">1 km</option>
          <option value="5">5 miles</option>
          <option value="25">25 miles</option>
        </select>
        <ShellActionSurface
          type="submit"
          variant="pill"
          disabled={busy || !postalCode.trim()}
        >
          Nearby
        </ShellActionSurface>
      </form>
      <ShellActionSurface variant="pill" disabled={busy} onClick={locate}>
        Use my location
      </ShellActionSurface>
      {busy ? <p role="status">Finding advisors…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {result?.items.map((person) => (
        <div className={styles.person} key={person.personRef}>
          <div>
            <div className={styles.row}>
              <ConnectionPersonAvatar
                label={person.name}
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
          No request-ready advisors found. Try a wider area or search by name.
        </p>
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

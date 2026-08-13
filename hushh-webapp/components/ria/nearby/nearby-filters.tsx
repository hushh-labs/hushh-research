"use client";

/**
 * Focus is the filter that earns its place on screen. The rest hide.
 *
 * Confidence barely discriminates on the approved dataset (ten of eleven records
 * are grade A), and radius matters little inside a single small market. Showing
 * four equal facets implied four useful decisions where there is really one.
 *
 * Lane counts come from the *unfiltered* result set. Deriving them from the
 * filtered one — the first version of this — zeroed every other lane the moment
 * you picked one, so the control disabled its own way out.
 */

import { useState } from "react";

import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { MUTED_TEXT } from "@/lib/morphy-ux/tokens/surfaces";
import {
  NEARBY_LANES,
  NEARBY_RADIUS_OPTIONS_KM,
  type ConfidenceGrade,
  type NearbyFilters,
  type NearbyLane,
} from "@/lib/services/nws-nearby-service";
import { cn } from "@/lib/utils";

export function NearbyFilterBar({
  filters,
  onChange,
  laneCounts,
  tags,
  disabled = false,
}: {
  filters: NearbyFilters;
  onChange: (next: NearbyFilters) => void;
  laneCounts: Record<NearbyLane, number>;
  tags: string[];
  disabled?: boolean;
}) {
  const [more, setMore] = useState(false);
  const activeLane = filters.lanes[0] ?? "";
  // An empty lane is not offered at all. There is nothing behind it, and a
  // disabled chip is still a chip competing for attention.
  const lanes = NEARBY_LANES.filter((lane) => (laneCounts[lane.value] ?? 0) > 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Chip
          label="All"
          active={activeLane === ""}
          disabled={disabled}
          onClick={() => onChange({ ...filters, lanes: [] })}
        />
        {lanes.map((lane) => (
          <Chip
            key={lane.value}
            label={lane.label}
            count={laneCounts[lane.value]}
            active={activeLane === lane.value}
            disabled={disabled}
            onClick={() =>
              onChange({
                ...filters,
                lanes: activeLane === lane.value ? [] : [lane.value],
              })
            }
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => setMore((v) => !v)}
        className={cn(MUTED_TEXT, "self-start underline-offset-4 hover:underline")}
      >
        {more ? "Fewer filters" : "More filters"}
      </button>

      {more ? (
        <div className="flex flex-col gap-3">
          {tags.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              <Chip
                label="Any sector"
                active={filters.tag === null}
                disabled={disabled}
                onClick={() => onChange({ ...filters, tag: null })}
              />
              {tags.map((tag) => (
                <Chip
                  key={tag}
                  label={tag}
                  active={filters.tag === tag}
                  disabled={disabled}
                  onClick={() =>
                    onChange({ ...filters, tag: filters.tag === tag ? null : tag })
                  }
                />
              ))}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <SegmentedTabs
              value={String(filters.radiusKm)}
              disabled={disabled}
              onValueChange={(v) => onChange({ ...filters, radiusKm: Number(v) })}
              options={NEARBY_RADIUS_OPTIONS_KM.map((km) => ({
                value: String(km),
                label: `${km} km`,
              }))}
            />
            <SegmentedTabs
              value={filters.minimumConfidenceGrade}
              disabled={disabled}
              onValueChange={(v) =>
                onChange({ ...filters, minimumConfidenceGrade: v as ConfidenceGrade })
              }
              options={[
                { value: "A", label: "A" },
                { value: "B", label: "B" },
                { value: "C", label: "C" },
                { value: "D", label: "All" },
              ]}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Chip({
  label,
  count,
  active,
  disabled,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "press-scale inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 type-footnote",
        "transition-[background-color,border-color,color] duration-200",
        active
          ? "border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-fg)]"
          : "border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] text-foreground",
      )}
    >
      <span>{label}</span>
      {typeof count === "number" ? (
        <span className={cn(MUTED_TEXT, "tabular-nums")}>{count}</span>
      ) : null}
    </button>
  );
}

"use client";

/**
 * The advisor's ideal-client filters, for this visit only.
 *
 * Two of these controls are shaped by what the data can actually support rather
 * than by what the API accepts, and both would look like bugs otherwise.
 *
 * Focus shows a live count per lane. Two of the six lanes are empty in the
 * approved dataset, so offering all six as equal choices means tapping one
 * returns a blank screen with no explanation.
 *
 * Sector takes one value at a time. The upstream matches tags as a *subset* of
 * a record's own tags, so two selections require a record carrying both — and
 * against the current dataset almost every pair returns nothing.
 */

import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { EYEBROW, MUTED_TEXT } from "@/lib/morphy-ux/tokens/surfaces";
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
  const activeLane = filters.lanes[0] ?? "";

  return (
    <div className="flex flex-col gap-4">
      <Facet label="Focus">
        <div className="flex flex-wrap gap-2">
          <Chip
            label="All"
            active={activeLane === ""}
            disabled={disabled}
            onClick={() => onChange({ ...filters, lanes: [] })}
          />
          {NEARBY_LANES.map((lane) => {
            const count = laneCounts[lane.value] ?? 0;
            return (
              <Chip
                key={lane.value}
                label={lane.label}
                count={count}
                active={activeLane === lane.value}
                // An empty lane stays visible but unselectable: hiding it would
                // imply the taxonomy is smaller than it is.
                disabled={disabled || count === 0}
                onClick={() => onChange({ ...filters, lanes: [lane.value] })}
              />
            );
          })}
        </div>
      </Facet>

      {tags.length > 0 ? (
        <Facet label="Sector">
          <div className="flex flex-wrap gap-2">
            <Chip
              label="Any"
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
        </Facet>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Facet label="Radius">
          <SegmentedTabs
            value={String(filters.radiusKm)}
            disabled={disabled}
            onValueChange={(value) =>
              onChange({ ...filters, radiusKm: Number(value) })
            }
            options={NEARBY_RADIUS_OPTIONS_KM.map((km) => ({
              value: String(km),
              label: `${km} km`,
            }))}
          />
        </Facet>

        <Facet label="Minimum confidence">
          <SegmentedTabs
            value={filters.minimumConfidenceGrade}
            disabled={disabled}
            onValueChange={(value) =>
              onChange({
                ...filters,
                minimumConfidenceGrade: value as ConfidenceGrade,
              })
            }
            options={[
              { value: "A", label: "A" },
              { value: "B", label: "B" },
              { value: "C", label: "C" },
              { value: "D", label: "All" },
            ]}
          />
        </Facet>
      </div>
    </div>
  );
}

function Facet({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className={EYEBROW}>{label}</span>
      {children}
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
        disabled && !active && "opacity-40",
      )}
    >
      <span>{label}</span>
      {typeof count === "number" ? (
        <span className={cn(MUTED_TEXT, "tabular-nums")}>{count}</span>
      ) : null}
    </button>
  );
}

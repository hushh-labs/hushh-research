import type { ConsentEventType } from "../../data/consentEvents";

type FilterType = "all" | ConsentEventType;

interface ConsentFiltersProps {
  activeFilter: FilterType;
  onFilterChange: (filter: FilterType) => void;
}

const filters: FilterType[] = ["all", "granted", "updated", "revoked", "expired"];

export default function ConsentFilters({
  activeFilter,
  onFilterChange,
}: ConsentFiltersProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {filters.map((filter) => (
        <button
          key={filter}
          onClick={() => onFilterChange(filter)}
          className={`rounded-full px-4 py-2 text-sm font-medium transition ${
            activeFilter === filter
              ? "bg-slate-900 text-white"
              : "bg-slate-100 text-slate-700 hover:bg-slate-200"
          }`}
        >
          {filter.charAt(0).toUpperCase() + filter.slice(1)}
        </button>
      ))}
    </div>
  );
}
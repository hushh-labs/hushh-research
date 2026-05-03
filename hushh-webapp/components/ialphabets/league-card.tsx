"use client";

interface LeagueCardProps {
  league: {
    id: string;
    name: string;
    privacy: string;
    status: string;
    member_count: number;
    max_members: number;
    created_at: string;
  };
  onClick: () => void;
}

export function LeagueCard({ league, onClick }: LeagueCardProps) {
  const statusColors: Record<string, string> = {
    open: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    active: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    drafting: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    closed: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  };

  return (
    <button
      onClick={onClick}
      className="w-full rounded-xl border bg-card p-4 text-left transition hover:border-primary/50 hover:shadow-sm"
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold">{league.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {league.member_count}/{league.max_members} members ·{" "}
            {league.privacy === "public" ? "Public" : "Private"}
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            statusColors[league.status] || statusColors.open
          }`}
        >
          {league.status}
        </span>
      </div>
    </button>
  );
}

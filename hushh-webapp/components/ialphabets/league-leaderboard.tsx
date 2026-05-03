"use client";

interface LeaderboardRow {
  user_id: string;
  display_name?: string;
  total_return_pct: number;
  current_value: number;
  rank_in_league: number | null;
  status: string;
}

interface LeagueLeaderboardProps {
  rows: LeaderboardRow[];
  currentUserId?: string;
}

export function LeagueLeaderboard({
  rows,
  currentUserId,
}: LeagueLeaderboardProps) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
              Rank
            </th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
              Player
            </th>
            <th className="px-4 py-3 text-right font-medium text-muted-foreground">
              Return
            </th>
            <th className="hidden px-4 py-3 text-right font-medium text-muted-foreground sm:table-cell">
              Value
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isMe = row.user_id === currentUserId;
            const returnColor =
              row.total_return_pct > 0
                ? "text-green-600 dark:text-green-400"
                : row.total_return_pct < 0
                  ? "text-red-600 dark:text-red-400"
                  : "text-muted-foreground";

            return (
              <tr
                key={row.user_id}
                className={`border-b transition last:border-b-0 ${
                  isMe ? "bg-primary/5" : "hover:bg-muted/30"
                }`}
              >
                <td className="px-4 py-3 font-bold">
                  {row.rank_in_league != null ? (
                    <span
                      className={
                        row.rank_in_league === 1
                          ? "text-yellow-500"
                          : row.rank_in_league === 2
                            ? "text-gray-400"
                            : row.rank_in_league === 3
                              ? "text-amber-700"
                              : ""
                      }
                    >
                      #{row.rank_in_league}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={isMe ? "font-semibold" : ""}>
                    {row.display_name || row.user_id.slice(0, 8)}
                    {isMe && (
                      <span className="ml-1.5 text-xs text-primary">(you)</span>
                    )}
                  </span>
                </td>
                <td className={`px-4 py-3 text-right font-mono font-semibold ${returnColor}`}>
                  {row.total_return_pct > 0 ? "+" : ""}
                  {row.total_return_pct.toFixed(2)}%
                </td>
                <td className="hidden px-4 py-3 text-right font-mono text-muted-foreground sm:table-cell">
                  ${Number(row.current_value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

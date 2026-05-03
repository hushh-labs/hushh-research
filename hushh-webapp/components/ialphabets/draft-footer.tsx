"use client";

interface DraftFooterProps {
  pickedCount: number;
  isFinalizing: boolean;
  onFinalize: () => void;
}

export function DraftFooter({
  pickedCount,
  isFinalizing,
  onFinalize,
}: DraftFooterProps) {
  const isComplete = pickedCount === 26;
  const progress = (pickedCount / 26) * 100;

  return (
    <div className="sticky bottom-0 mt-6 rounded-xl border bg-card p-4 shadow-lg">
      {/* Progress bar */}
      <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">
          {pickedCount}/26 letters picked
        </span>
        <button
          onClick={onFinalize}
          disabled={!isComplete || isFinalizing}
          className={`rounded-lg px-6 py-2.5 text-sm font-semibold transition
            ${
              isComplete
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "bg-muted text-muted-foreground cursor-not-allowed"
            }
            disabled:opacity-50
          `}
        >
          {isFinalizing ? "Finalizing..." : isComplete ? "Lock In My Alphabet" : `${26 - pickedCount} more to go`}
        </button>
      </div>
    </div>
  );
}

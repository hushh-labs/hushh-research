import { Calendar } from "@/components/icons";

interface HoldingAcquisitionDateFieldProps {
  value?: string;
  max: string;
  error?: string;
  onChange: (value: string) => void;
}

function formatAcquisitionDate(value?: string): string {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${month}/${day}/${year}`;
}

export function HoldingAcquisitionDateField({
  value,
  max,
  error,
  onChange,
}: HoldingAcquisitionDateFieldProps) {
  return (
    <div>
      <label htmlFor="holding-acquisition-date" className="block text-sm font-medium mb-1">
        Acquisition Date
      </label>
      <div className="relative">
        {/* iOS opens its native picker only from a direct tap on the real
            full-size input; the visible display must never intercept taps. */}
        <div aria-hidden="true" className="pointer-events-none flex h-12 w-full items-center rounded-xl border border-border bg-background px-4 pr-12 transition-colors">
          <span className={value ? "" : "text-muted-foreground"}>
            {formatAcquisitionDate(value) || "MM/DD/YYYY"}
          </span>
        </div>
        <span aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground">
          <Calendar className="h-4 w-4" />
        </span>
        <input
          id="holding-acquisition-date"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "holding-acquisition-date-error" : undefined}
          type="date"
          value={value || ""}
          onChange={(event) => onChange(event.target.value)}
          max={max}
          aria-label="Acquisition date"
          className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:cursor-pointer"
        />
      </div>
      {error && <p id="holding-acquisition-date-error" className="text-sm text-red-500 mt-1">{error}</p>}
    </div>
  );
}

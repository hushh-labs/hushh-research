import { HushhLoader } from "@/components/app-ui/hushh-loader";

type RouteSuspenseFallbackProps = {
  label?: string;
};

export function RouteSuspenseFallback({
  label = "Loading page…",
}: RouteSuspenseFallbackProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[320px] items-center justify-center px-6 py-12"
    >
      <HushhLoader variant="inline" label={label} />
    </div>
  );
}
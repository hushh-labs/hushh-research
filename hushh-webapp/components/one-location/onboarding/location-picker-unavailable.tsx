import { MapPin } from "@/components/icons";

/** Recovery copy keeps the captured point usable when the renderer is down. */
export function LocationPickerUnavailable({ descriptionId, compact, onRecapture }: { descriptionId: string; compact: boolean; onRecapture?: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 flex h-full flex-col items-center justify-center gap-2 bg-[#eef2f7] px-6 text-center dark:bg-[#10151d]"
    >
      <MapPin
        className="h-7 w-7 text-[#8b93a1]"
        strokeWidth={2}
        aria-hidden
      />
      <p data-location-type-role="helper"
        id={descriptionId}
        className="text-[13px] font-medium text-[#5b6472] dark:text-[#9aa6b6]"
      >
        {compact ? "Map preview unavailable. You can enter the address for this point." : "The interactive map isn't available right now. You can continue with the captured point and complete the address manually."}
      </p>
      {onRecapture && <button type="button" onClick={onRecapture} className="min-h-11 rounded-full bg-white px-4 text-[color:var(--app-accent-deep,#0b62c4)] shadow-sm dark:bg-[#1c2430] dark:text-[#9bc7f5]">Retry location capture</button>}
    </div>
  );
}

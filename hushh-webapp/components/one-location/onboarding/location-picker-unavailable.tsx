import { MapPin } from "@/components/icons";

/** Recovery copy keeps the captured point usable when the renderer is down. */
export function LocationPickerUnavailable({ descriptionId, compact }: { descriptionId: string; compact: boolean }) {
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
        {compact ? "Map unavailable. Check the captured address." : "The interactive map isn't available right now. You can continue with the captured point and complete the address manually."}
      </p>
    </div>
  );
}

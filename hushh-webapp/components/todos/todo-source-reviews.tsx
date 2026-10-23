import Link from "next/link";
import { ChevronRight } from "@/components/icons";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import { CaptionText, MediumRowLabel } from "@/components/app-ui/typography";
import { getOneCapability } from "@/lib/onboarding/one-capabilities";
import { normalizeInternalRouteHref } from "@/lib/navigation/routes";
import type { TaskEvidence } from "@/lib/todos/task-suggestion-model";

/** Reading messages or resolving a Memory disagreement belongs to its source.
 * These links never mark source work complete or create a durable task. */
export function TodoSourceReviews({ reviews }: { reviews: TaskEvidence[] }) {
  if (!reviews.length) return null;
  return <section aria-label="Source reviews" className="space-y-2">
    {reviews.map(item => {
      const href = normalizeInternalRouteHref(item.href);
      if (!href || !item.reviewTitle) return null;
      return <SurfaceCard key={item.key}>
        <Link href={href} className="flex min-h-11 items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <CaptionText as="p">{getOneCapability(item.capability)?.title}</CaptionText>
            <MediumRowLabel as="p">{item.reviewTitle}</MediumRowLabel>
          </div>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
      </SurfaceCard>;
    })}
  </section>;
}

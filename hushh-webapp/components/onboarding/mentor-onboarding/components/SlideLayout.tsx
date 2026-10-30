import type { ReactNode } from "react";

import { PAID_ACCESS_DESCRIPTION } from "../content";
import type { Story, StoryScreenProps } from "../types";

interface SlideLayoutProps extends Omit<StoryScreenProps, "active" | "motion" | "assetBaseUrl"> {
  story: Story;
  children: ReactNode;
}

/** One artboard: stacked on phone, art/copy columns at the reference breakpoint. */
export function SlideLayout({
  story,
  children,
  footer,
  headingId,
  paidDocumentAccess,
  invitationContent,
}: SlideLayoutProps) {
  const description = story.id === "control" && paidDocumentAccess
    ? PAID_ACCESS_DESCRIPTION
    : story.description;

  return (
    <section
      className={`ao-slide ao-slide--${story.id}`}
      data-story={story.id}
      data-intro-v2-card="true"
      aria-labelledby={headingId}
    >
      <div className="ao-hero" aria-hidden="true">
        <div className="ao-scene">{children}</div>
      </div>
      <div className="ao-sheet">
        <div className="ao-copy">
          <h1
            data-location-type-role="flow-title"
            id={headingId}
            className="ao-title"
            tabIndex={-1}
            data-intro-v2-title="true"
            data-intro-v2-active-heading="true"
          >
            <span>{story.title[0]}</span>
            <span>{story.title[1]}</span>
          </h1>
          <p data-location-type-role="row-description" className="ao-description">{description}</p>
          {story.id === "control" && invitationContent ? (
            <div className="ao-invitation">{invitationContent}</div>
          ) : null}
        </div>
        <div className="ao-footer">{footer}</div>
      </div>
    </section>
  );
}

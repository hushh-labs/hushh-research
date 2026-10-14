import { STORIES } from "../content";
import { Icon } from "./Icons";

interface OnboardingFooterProps {
  index: number;
  onChange: (index: number) => void;
  onNext: () => void;
  onSkip: () => void;
  finalActionLabel: string;
  completionDisabled: boolean;
  busy: boolean;
  error: string;
}

export function OnboardingFooter({
  index,
  onChange,
  onNext,
  onSkip,
  finalActionLabel,
  completionDisabled,
  busy,
  error,
}: OnboardingFooterProps) {
  const last = index === STORIES.length - 1;

  return (
    <>
      <div className="ao-progress-row">
        <button
          type="button"
          className="ao-back"
          aria-label="Previous screen"
          style={{ visibility: index > 0 ? "visible" : "hidden" }}
          disabled={index === 0 || busy}
          onClick={() => onChange(index - 1)}
        >
          <Icon name="back" size={20} />
        </button>
        <nav className="ao-progress" aria-label="Onboarding screens">
          {STORIES.map((story, target) => (
            <button
              type="button"
              key={story.id}
              disabled={busy}
              aria-label={`Screen ${target + 1} of ${STORIES.length}: ${story.label}`}
              aria-current={target === index ? "step" : undefined}
              onClick={() => onChange(target)}
            >
              <span className={target === index ? "is-current" : ""} />
            </button>
          ))}
        </nav>
        <span className="ao-progress-spacer" aria-hidden="true" />
      </div>
      <div className="ao-actions">
        <button
          type="button"
          className="ao-skip"
          disabled={busy || completionDisabled}
          onClick={onSkip}
        >
          Skip
        </button>
        <button
          type="button"
          className="ao-primary"
          onClick={onNext}
          disabled={busy || (last && completionDisabled)}
          aria-busy={busy || undefined}
          data-voice-control-id={last ? "onboarding_claim_one" : undefined}
        >
          <span>{busy ? "Continuing…" : last ? finalActionLabel : "Next"}</span>
          <Icon name="arrow" size={19} />
        </button>
      </div>
      {error ? <p className="ao-error" role="alert">{error}</p> : null}
    </>
  );
}

import type { ReactNode } from "react";
import type { PwmResult } from "@/lib/services/world-model-research-service";

type Offered = Extract<PwmResult, { status: "offered" }>;
type GroundedAnswer = Offered["grounded_answers"][number];

/** Preserve Azure's answer text and citation offsets as received from Bing. */
export function AzureGroundedAnswer({
  answer,
  index,
}: {
  answer: GroundedAnswer;
  index: number;
}) {
  const citations = answer.citations;
  if (!citations?.length) return null;

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [citationIndex, citation] of citations.entries()) {
    parts.push(answer.answer.slice(cursor, citation.start_index));
    parts.push(
      <a
        key={citationIndex}
        href={citation.url}
        title={citation.title || "Public page"}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        className="font-medium text-[color:var(--app-accent)] underline underline-offset-2"
      >
        {answer.answer.slice(citation.start_index, citation.end_index)}
      </a>,
    );
    cursor = citation.end_index;
  }
  parts.push(answer.answer.slice(cursor));

  return (
    <article className="space-y-2 px-4 py-3" data-testid="pwm-azure-grounded-answer">
      <h3 className="text-sm font-medium">Bing web result {index + 1}</h3>
      <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{parts}</p>
      <ol className="list-inside list-decimal space-y-1" aria-label={`Bing citations for result ${index + 1}`}>
        {citations.map((citation, citationIndex) => (
          <li key={citationIndex} className="text-xs [overflow-wrap:anywhere]">
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className="font-medium text-[color:var(--app-accent)] underline underline-offset-2"
            >
              {citation.title || "Public page"}
            </a>
            <span className="block text-muted-foreground">{citation.url}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}

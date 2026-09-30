/**
 * Turns Kai's XML-compatible debate statement into safe presentation text.
 *
 * The debate runtime retains this compact markup for server-side insight
 * extraction. It is never HTML and must remain plain text in the browser.
 * This formatter recognizes only the fixed debate schema, preserving any
 * unknown text for React's normal escaped rendering.
 */

function attributeValue(attributes: string, name: string): string {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*[\"']([^\"']*)[\"']`, "i"),
  );
  return match?.[1]?.replace(/[<>*\r\n]/g, " ").trim() ?? "";
}

function titleCase(value: string): string {
  return value
    .replace(/[\/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function confidenceLabel(value: string): string {
  if (!value.trim()) return "";
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    return "";
  return `${Math.round(confidence * 100)}% confidence`;
}

function scoreLabel(value: string): string {
  if (!value.trim()) return "";
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 10) return "";
  return `${score}/10`;
}

function sectionHeading(label: string, details: string[] = []): string {
  return `\n\n**${[label, ...details.filter(Boolean)].join(" · ")}**\n`;
}

/**
 * Formats only the documented XML-compatible Kai debate tags. Unknown tags
 * stay as literal text, rather than being parsed as browser markup.
 */
export function formatDebateAnalysisForDisplay(text: string): string {
  if (
    !/<(?:analysis|thought|claim|evidence|portfolio_impact|bull_case_personalized|bear_case_personalized|renaissance_verdict)\b/i.test(
      text,
    )
  ) {
    return text;
  }

  const formatted = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<analysis\b[^>]*>/gi, "")
    .replace(/<\/analysis\s*>/gi, "")
    .replace(/<thought\b[^>]*>/gi, sectionHeading("Reasoning"))
    .replace(/<claim\b([^>]*)>/gi, (_match, attributes: string) => {
      const type = titleCase(attributeValue(attributes, "type"));
      const confidence = confidenceLabel(
        attributeValue(attributes, "confidence"),
      );
      return sectionHeading("Claim", [type, confidence]);
    })
    .replace(/<evidence\b([^>]*)>/gi, (_match, attributes: string) =>
      sectionHeading("Evidence", [attributeValue(attributes, "source")]),
    )
    .replace(/<portfolio_impact\b([^>]*)>/gi, (_match, attributes: string) => {
      const type = titleCase(attributeValue(attributes, "type"));
      const magnitude = titleCase(attributeValue(attributes, "magnitude"));
      const score = attributeValue(attributes, "score");
      return sectionHeading("Portfolio impact", [
        type,
        magnitude,
        scoreLabel(score),
      ]);
    })
    .replace(
      /<bull_case_personalized\b[^>]*>/gi,
      sectionHeading("Personalized bull case"),
    )
    .replace(
      /<bear_case_personalized\b[^>]*>/gi,
      sectionHeading("Personalized bear case"),
    )
    .replace(
      /<renaissance_verdict\b[^>]*>/gi,
      sectionHeading("Renaissance verdict"),
    )
    .replace(
      /<\/(?:thought|claim|evidence|portfolio_impact|bull_case_personalized|bear_case_personalized|renaissance_verdict)\s*>/gi,
      "\n",
    );

  return formatted
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

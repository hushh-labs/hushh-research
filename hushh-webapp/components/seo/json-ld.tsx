/**
 * Renders a JSON-LD structured-data block.
 *
 * Uses a <script type="application/ld+json"> tag. The payload is serialized
 * with JSON.stringify (no user input is interpolated), so it is safe to inject
 * via dangerouslySetInnerHTML for crawler/answer-engine consumption (AEO).
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

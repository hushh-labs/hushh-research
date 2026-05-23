/**
 * Safely parse backend responses.
 *
 * Handles:
 * - JSON responses
 * - text responses
 * - empty responses
 *
 * Preserves route contract:
 * Always returns an object.
 */

export async function safeParseResponse(
  response: Response
): Promise<Record<string, unknown>> {

  const contentType =
    response.headers.get(
      "content-type"
    ) ?? "";

  try {
    if (
      contentType.includes(
        "application/json"
      )
    ) {
      const json =
        await response.json();

      return (
        json &&
        typeof json ===
          "object"
      )
        ? (
            json as Record<
              string,
              unknown
            >
          )
        : {};
    }
  } catch {
    // preserve existing behavior
  }

  try {
    const text =
      await response.text();

    return text
      ? {
          upstreamError:
            text,
        }
      : {};
  } catch {
    return {};
  }
}
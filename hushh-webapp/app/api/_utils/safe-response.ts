export async function safeParseResponse(response: Response) {
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    return text ? { error: text } : {};
  }

  try {
    return await response.json();
  } catch {
    const text = await response.text().catch(() => "");
    return text ? { error: text } : {};
  }
}
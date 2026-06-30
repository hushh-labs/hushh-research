export async function fetchDemoPortfolioTemplateAsset(): Promise<unknown> {
  const cacheBust = "v=2026-02-25";
  const assetPath = `/demo-mode/portfolio-template.json?${cacheBust}`;
  const assetUrl =
    typeof window !== "undefined"
      ? new URL(assetPath, window.location.origin).toString()
      : assetPath;

  const response = await fetch(assetUrl, {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
  });

  if (!response.ok) {
    throw new Error("Demo template unavailable.");
  }

  return response.json().catch(() => ({}));
}

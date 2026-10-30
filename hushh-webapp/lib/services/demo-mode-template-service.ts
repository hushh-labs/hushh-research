import { fetchWithWebTimeout } from "@/lib/services/api-service";

const DEMO_TEMPLATE_TIMEOUT_MS = 15_000;

async function readDemoTemplateJson(response: Response): Promise<unknown> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error("Demo template response timed out.")),
      DEMO_TEMPLATE_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([response.json().catch(() => ({})), timeoutPromise]);
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
}

export async function fetchDemoPortfolioTemplateAsset(): Promise<unknown> {
  const cacheBust = "v=2026-02-25";
  const assetPath = `/demo-mode/portfolio-template.json?${cacheBust}`;
  const assetUrl =
    typeof window !== "undefined"
      ? new URL(assetPath, window.location.origin).toString()
      : assetPath;

  const response = await fetchWithWebTimeout(assetUrl, {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
  }, DEMO_TEMPLATE_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error("Demo template unavailable.");
  }

  return readDemoTemplateJson(response);
}

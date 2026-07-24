export type UrlQueryValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export type UrlQueryParams = Record<
  string,
  UrlQueryValue | UrlQueryValue[]
>;

export function buildUrlWithQuery(
  baseUrl: string,
  params?: UrlQueryParams
): string {
  const url = new URL(baseUrl, "http://localhost");

  Object.entries(params ?? {}).forEach(([key, value]) => {
    const values = Array.isArray(value) ? value : [value];

    values.forEach((item) => {
      if (item === null || item === undefined) return;
      const normalized = typeof item === "string" ? item.trim() : String(item);
      if (normalized === "") return;
      url.searchParams.append(key, normalized);
    });
  });

  if (baseUrl.startsWith("/")) {
    return `${url.pathname}${url.search}${url.hash}`;
  }

  return url.toString();
}

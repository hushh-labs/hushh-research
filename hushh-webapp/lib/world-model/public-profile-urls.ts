/** Public discovery leads only. Never extract links from private statement text. */
export function publicProfileUrls(values: readonly string[]): string[] {
  return [...new Set(values)].filter((value) => {
    try {
      const url = new URL(value);
      const host = url.hostname;
      return value.length <= 2048 && url.protocol === "https:" &&
        host.includes(".") && !url.username && !url.password &&
        !url.search && !url.hash && !url.port &&
        !host.includes(":") && !/^\d+\.\d+\.\d+\.\d+$/.test(host) &&
        ![".localhost", ".local", ".internal"].some((suffix) => host.endsWith(suffix));
    } catch {
      return false;
    }
  }).slice(0, 3);
}

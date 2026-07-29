import path from "node:path";

const PERMITTED_STATIC_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".json",
  ".txt",
  ".ico",
  ".css",
  ".js",
]);

export function isValidExtension(filePath: string): boolean {
  const normalizedPath = filePath.trim();
  if (
    !normalizedPath ||
    normalizedPath.endsWith("/") ||
    normalizedPath.endsWith("\\")
  ) {
    return false;
  }

  const extension = path.extname(normalizedPath).toLowerCase();
  return extension.length > 0 && PERMITTED_STATIC_ASSET_EXTENSIONS.has(extension);
}

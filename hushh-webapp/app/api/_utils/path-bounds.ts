import path from "node:path";

export function isPathWithinBounds(baseDir: string, targetPath: string): boolean {
  if (baseDir.trim().length === 0 || targetPath.trim().length === 0) {
    return false;
  }

  const resolvedBaseDir = path.resolve(baseDir);
  const resolvedTargetPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(resolvedBaseDir, targetPath);
  const relativePath = path.relative(resolvedBaseDir, resolvedTargetPath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

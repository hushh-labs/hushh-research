import path from "node:path";

export type StaticAssetPathErrorCode =
  | "EMPTY_BASE_DIRECTORY"
  | "EMPTY_ASSET_PATH"
  | "MALFORMED_ENCODING"
  | "EXCESSIVE_ENCODING_DEPTH"
  | "NULL_BYTE"
  | "CONTROL_CHARACTER"
  | "ABSOLUTE_PATH"
  | "DISALLOWED_CHARACTER"
  | "PATH_TRAVERSAL";

export interface StaticAssetPathGuardOptions {
  baseDirectory: string;
  assetPath: string;
  maxDecodeDepth?: number;
}

export interface StaticAssetPathGuardError {
  code: StaticAssetPathErrorCode;
  message: string;
}

export interface StaticAssetPathGuardSuccess {
  ok: true;
  baseDirectory: string;
  resolvedPath: string;
  normalizedRelativePath: string;
  decodedAssetPath: string;
}

export interface StaticAssetPathGuardFailure {
  ok: false;
  error: StaticAssetPathGuardError;
}

export type StaticAssetPathGuardResult =
  | StaticAssetPathGuardSuccess
  | StaticAssetPathGuardFailure;

interface DecodeSuccess {
  ok: true;
  decoded: string;
}

interface DecodeFailure {
  ok: false;
  error: StaticAssetPathGuardError;
}

type DecodeResult = DecodeSuccess | DecodeFailure;

const DEFAULT_MAX_DECODE_DEPTH = 4;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function failure(
  code: StaticAssetPathErrorCode,
  message: string
): StaticAssetPathGuardFailure {
  return { ok: false, error: { code, message } };
}

function decodeAssetPath(value: string, maxDepth: number): DecodeResult {
  let current = value;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (current.includes("\0")) {
      return {
        ok: false,
        error: {
          code: "NULL_BYTE",
          message: "Static asset path contains a null byte.",
        },
      };
    }

    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) {
        return { ok: true, decoded };
      }
      current = decoded;
    } catch {
      return {
        ok: false,
        error: {
          code: "MALFORMED_ENCODING",
          message: "Static asset path contains malformed percent encoding.",
        },
      };
    }
  }

  return {
    ok: false,
    error: {
      code: "EXCESSIVE_ENCODING_DEPTH",
      message: "Static asset path exceeded the allowed decoding depth.",
    },
  };
}

function hasProtocolOrDrivePrefix(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function isFilesystemAbsolute(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  );
}

function isWithinBaseDirectory(baseDirectory: string, targetPath: string): boolean {
  const relative = path.relative(baseDirectory, targetPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function resolveStaticAssetPath(
  options: StaticAssetPathGuardOptions
): StaticAssetPathGuardResult {
  const baseDirectory = options.baseDirectory.trim();
  if (!baseDirectory) {
    return failure(
      "EMPTY_BASE_DIRECTORY",
      "Static asset base directory must be a non-empty string."
    );
  }

  if (options.assetPath.length === 0) {
    return failure(
      "EMPTY_ASSET_PATH",
      "Static asset path must be a non-empty string."
    );
  }

  const maxDecodeDepth =
    typeof options.maxDecodeDepth === "number" &&
    Number.isFinite(options.maxDecodeDepth) &&
    options.maxDecodeDepth > 0
      ? Math.floor(options.maxDecodeDepth)
      : DEFAULT_MAX_DECODE_DEPTH;
  const decoded = decodeAssetPath(options.assetPath, maxDecodeDepth);
  if (!decoded.ok) {
    return { ok: false, error: decoded.error };
  }

  if (decoded.decoded.includes("\0")) {
    return failure("NULL_BYTE", "Static asset path contains a null byte.");
  }

  if (CONTROL_CHARACTER_PATTERN.test(decoded.decoded)) {
    return failure(
      "CONTROL_CHARACTER",
      "Static asset path contains a control character."
    );
  }

  if (decoded.decoded.includes("?") || decoded.decoded.includes("#")) {
    return failure(
      "DISALLOWED_CHARACTER",
      "Static asset path must not include query strings or fragments."
    );
  }

  if (
    hasProtocolOrDrivePrefix(decoded.decoded) ||
    isFilesystemAbsolute(decoded.decoded)
  ) {
    return failure(
      "ABSOLUTE_PATH",
      "Static asset path must be relative to the authorized base directory."
    );
  }

  let candidatePath = decoded.decoded;
  candidatePath = candidatePath.replace(/\\/g, "/");

  if (candidatePath.startsWith("/") || candidatePath.startsWith("//")) {
    return failure(
      "ABSOLUTE_PATH",
      "Static asset path must be relative to the authorized base directory."
    );
  }

  const segments = candidatePath.split("/").filter(Boolean);
  if (segments.length === 0) {
    return failure(
      "EMPTY_ASSET_PATH",
      "Static asset path must resolve to a file beneath the base directory."
    );
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      return failure(
        "PATH_TRAVERSAL",
        "Static asset path contains a traversal segment."
      );
    }
    if (segment.includes(":")) {
      return failure(
        "DISALLOWED_CHARACTER",
        "Static asset path contains a disallowed path character."
      );
    }
  }

  const resolvedBaseDirectory = path.resolve(baseDirectory);
  const resolvedPath = path.resolve(resolvedBaseDirectory, ...segments);
  if (!isWithinBaseDirectory(resolvedBaseDirectory, resolvedPath)) {
    return failure(
      "PATH_TRAVERSAL",
      "Static asset path resolves outside the authorized base directory."
    );
  }

  return {
    ok: true,
    baseDirectory: resolvedBaseDirectory,
    resolvedPath,
    normalizedRelativePath: segments.join("/"),
    decodedAssetPath: decoded.decoded,
  };
}

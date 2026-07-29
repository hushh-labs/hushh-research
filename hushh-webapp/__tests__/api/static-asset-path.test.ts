import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveStaticAssetPath,
  type StaticAssetPathErrorCode,
} from "@/app/api/_utils/static-asset-path";

const BASE_DIRECTORY = path.resolve("public", "static-assets");

function expectRejected(
  assetPath: string,
  expectedCode: StaticAssetPathErrorCode
): void {
  const result = resolveStaticAssetPath({
    baseDirectory: BASE_DIRECTORY,
    assetPath,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(expectedCode);
  }
}

describe("resolveStaticAssetPath", () => {
  it("resolves ordinary relative asset paths inside the authorized base directory", () => {
    const result = resolveStaticAssetPath({
      baseDirectory: BASE_DIRECTORY,
      assetPath: "images/logo.png",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseDirectory).toBe(BASE_DIRECTORY);
      expect(result.normalizedRelativePath).toBe("images/logo.png");
      expect(result.resolvedPath).toBe(
        path.join(BASE_DIRECTORY, "images", "logo.png")
      );
    }
  });

  it("rejects URL-style root-relative paths as absolute input", () => {
    const result = resolveStaticAssetPath({
      baseDirectory: BASE_DIRECTORY,
      assetPath: "/images/logo.png",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ABSOLUTE_PATH");
    }
  });

  it("rejects direct traversal segments across POSIX and Windows separators", () => {
    expectRejected("../secret.env", "PATH_TRAVERSAL");
    expectRejected("..\\secret.env", "PATH_TRAVERSAL");
    expectRejected("images/../secret.env", "PATH_TRAVERSAL");
    expectRejected("images\\..\\secret.env", "PATH_TRAVERSAL");
  });

  it("rejects encoded and double-encoded traversal payloads", () => {
    expectRejected("%2e%2e%2fsecret.env", "PATH_TRAVERSAL");
    expectRejected("%2e%2e%5csecret.env", "PATH_TRAVERSAL");
    expectRejected("%252e%252e%252fsecret.env", "PATH_TRAVERSAL");
    expectRejected("images%2f..%2fsecret.env", "PATH_TRAVERSAL");
  });

  it("rejects raw and encoded null byte injection attempts", () => {
    expectRejected("images/logo.png\0.txt", "NULL_BYTE");
    expectRejected("images/logo.png%00.txt", "NULL_BYTE");
    expectRejected("images/logo.png%2500.txt", "NULL_BYTE");
  });

  it("rejects malformed or excessive percent encoding without throwing", () => {
    expectRejected("images/%zz/logo.png", "MALFORMED_ENCODING");

    const excessive = resolveStaticAssetPath({
      baseDirectory: BASE_DIRECTORY,
      assetPath: "%252525252e",
      maxDecodeDepth: 1,
    });
    expect(excessive.ok).toBe(false);
    if (!excessive.ok) {
      expect(excessive.error.code).toBe("EXCESSIVE_ENCODING_DEPTH");
    }
  });

  it("rejects absolute filesystem paths, drive paths, protocols, and UNC-like paths", () => {
    expectRejected("/etc/passwd", "ABSOLUTE_PATH");
    expectRejected("C:\\Windows\\win.ini", "ABSOLUTE_PATH");
    expectRejected("file:///etc/passwd", "ABSOLUTE_PATH");
    expectRejected("\\\\server\\share\\secret.txt", "ABSOLUTE_PATH");
    expectRejected("//server/share/secret.txt", "ABSOLUTE_PATH");
  });

  it("rejects query strings, fragments, and control characters", () => {
    expectRejected("images/logo.png?download=1", "DISALLOWED_CHARACTER");
    expectRejected("images/logo.png#section", "DISALLOWED_CHARACTER");
    expectRejected("images/logo.png\n.txt", "CONTROL_CHARACTER");
  });

  it("returns structured errors for empty inputs instead of throwing", () => {
    const emptyBase = resolveStaticAssetPath({
      baseDirectory: " ",
      assetPath: "logo.png",
    });
    expect(emptyBase.ok).toBe(false);
    if (!emptyBase.ok) {
      expect(emptyBase.error.code).toBe("EMPTY_BASE_DIRECTORY");
    }

    const emptyAsset = resolveStaticAssetPath({
      baseDirectory: BASE_DIRECTORY,
      assetPath: "",
    });
    expect(emptyAsset.ok).toBe(false);
    if (!emptyAsset.ok) {
      expect(emptyAsset.error.code).toBe("EMPTY_ASSET_PATH");
    }
  });
});

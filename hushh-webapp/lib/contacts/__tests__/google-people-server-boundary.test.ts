import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "../../..");
const SERVER_ROOTS = ["pages", "lib/server"];
const GRAPH_ROOTS = ["app", "pages", "lib", "components", "hooks"];
const SOURCE_EXTENSIONS = [".js", ".jsx", ".mjs", ".ts", ".tsx"] as const;
const SOURCE_EXTENSION_SET = new Set<string>(SOURCE_EXTENSIONS);
const SOURCE_CACHE = new Map<string, string>();
const DEPENDENCY_CACHE = new Map<string, string[]>();
const FORBIDDEN_FILES = new Set(
  ["lib/contacts/google-people-source.ts", "lib/contacts/google-contacts-token.ts"].map(
    (file) => path.resolve(WEB_ROOT, file),
  ),
);

function sourceFilesBelow(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return [".next", "__tests__", "node_modules"].includes(entry.name)
        ? []
        : sourceFilesBelow(candidate);
    }
    if (/\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(entry.name)) return [];
    return SOURCE_EXTENSION_SET.has(path.extname(entry.name)) ? [candidate] : [];
  });
}

function sourceFor(file: string): string {
  const absolute = path.resolve(file);
  const cached = SOURCE_CACHE.get(absolute);
  if (cached !== undefined) return cached;
  const source = readFileSync(absolute, "utf8");
  SOURCE_CACHE.set(absolute, source);
  return source;
}

function nextServerFiles(): string[] {
  const files = new Set<string>();
  for (const relativeRoot of SERVER_ROOTS) {
    for (const file of sourceFilesBelow(path.join(WEB_ROOT, relativeRoot))) {
      files.add(file);
    }
  }

  // Seed every Next App Router server entrypoint, explicit Server Action, and
  // server-only module. Dependencies are traversed below until a top-level
  // `use client` boundary is reached.
  for (const relativeRoot of GRAPH_ROOTS) {
    for (const file of sourceFilesBelow(path.join(WEB_ROOT, relativeRoot))) {
      const name = path.basename(file);
      const source = sourceFor(file);
      if (
        /^(?:page|layout|template|default|loading|error|global-error|not-found|forbidden|unauthorized|route|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.[cm]?[jt]sx?$/u.test(
          name,
        ) ||
        /\.server\.[cm]?[jt]sx?$/u.test(name) ||
        /^\s*["']use server["'];?/mu.test(source) ||
        /^\s*import\s+["']server-only["'];?/mu.test(source)
      ) {
        files.add(file);
      }
    }
  }

  for (const name of ["middleware", "proxy", "instrumentation"]) {
    for (const extension of SOURCE_EXTENSIONS) {
      const candidate = path.join(WEB_ROOT, `${name}${extension}`);
      if (existsSync(candidate)) files.add(candidate);
    }
  }
  return [...files];
}

function isClientBoundary(file: string): boolean {
  const sourceFile = ts.createSourceFile(
    file,
    sourceFor(file),
    ts.ScriptTarget.Latest,
    false,
  );
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      return false;
    }
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

function resolveSourceImport(importer: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.resolve(WEB_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(importer), specifier);
  } else {
    return null;
  }

  const candidates = [base];
  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(`${base}${extension}`, path.join(base, `index${extension}`));
  }

  const explicitExtension = path.extname(base);
  if (SOURCE_EXTENSION_SET.has(explicitExtension)) {
    const withoutExtension = base.slice(0, -explicitExtension.length);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${withoutExtension}${extension}`);
  }

  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

function sourceDependencies(file: string): string[] {
  const absolute = path.resolve(file);
  const cached = DEPENDENCY_CACHE.get(absolute);
  if (cached !== undefined) return cached;
  const source = sourceFor(absolute);
  const imports = ts.preProcessFile(source, true, true).importedFiles;
  const dependencies = imports.flatMap(({ fileName }) => {
    const resolved = resolveSourceImport(absolute, fileName);
    return resolved ? [resolved] : [];
  });
  DEPENDENCY_CACHE.set(absolute, dependencies);
  return dependencies;
}

function relative(file: string): string {
  return path.relative(WEB_ROOT, file).replaceAll("\\", "/");
}

describe("Google Contacts server boundary", () => {
  it("keeps the People API and browser token adapter out of the transitive server graph", () => {
    const offenders = new Set<string>();
    const queue = nextServerFiles().map((file) => ({ file, chain: [file] }));
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      const absolute = path.resolve(current.file);
      const renderedChain = current.chain.map(relative).join(" -> ");

      if (visited.has(absolute) || isClientBoundary(absolute)) continue;
      visited.add(absolute);

      if (FORBIDDEN_FILES.has(absolute)) offenders.add(renderedChain);
      if (sourceFor(absolute).includes("people.googleapis.com")) {
        offenders.add(`${renderedChain} -> people.googleapis.com`);
      }

      for (const dependency of sourceDependencies(absolute)) {
        queue.push({ file: dependency, chain: [...current.chain, dependency] });
      }
    }

    expect(
      [...offenders].sort(),
      "Google Contacts must stay browser-direct; server code may not receive its token or raw response.",
    ).toEqual([]);
  }, 60_000);
});

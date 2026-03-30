const fs = require("node:fs");
const path = require("node:path");

function repoRootFromHere() {
  // scripts/verify-route-contracts.cjs -> hushh-webapp/scripts -> hushh-webapp -> repo root
  return path.resolve(__dirname, "..", "..");
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function listWebRouteFiles(repoRoot) {
  const appApiDir = path.join(repoRoot, "hushh-webapp", "app", "api");
  const out = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === "route.ts") out.push(full);
    }
  };

  if (exists(appApiDir)) walk(appApiDir);
  return out;
}

function listPageRouteFiles(repoRoot) {
  const appDir = path.join(repoRoot, "hushh-webapp", "app");
  const out = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "api") continue;
        walk(full);
      } else if (entry.isFile() && entry.name === "page.tsx") {
        out.push(full);
      }
    }
  };

  if (exists(appDir)) walk(appDir);
  return out;
}

function normalizeToForwardSlashes(p) {
  return p.replace(/\\/g, "/");
}

function resolveRepoFile(repoRoot, repoRelativeFile) {
  return path.join(repoRoot, repoRelativeFile);
}

function loadAppRouteLayoutContract(repoRoot) {
  const contractPath = path.join(
    repoRoot,
    "hushh-webapp",
    "lib",
    "navigation",
    "app-route-layout.contract.json"
  );
  if (!exists(contractPath)) {
    throw new Error(
      `Missing app route layout contract: hushh-webapp/lib/navigation/app-route-layout.contract.json`
    );
  }
  return JSON.parse(readText(contractPath));
}

function getDeclaredWebRouteFiles(manifest) {
  const files = [];
  for (const c of manifest.contracts) {
    if (c.webRouteFile) files.push(c.webRouteFile);
    if (c.webRouteFiles) files.push(...c.webRouteFiles);
  }
  return files;
}

function getDeclaredPageRouteFiles(manifest) {
  const files = [];
  for (const c of manifest.pageContracts || []) {
    if (c.pageFile) files.push(c.pageFile);
  }
  return files;
}

function assertDeclaredWebRoutesExist(repoRoot, manifest) {
  const declared = getDeclaredWebRouteFiles(manifest).map(
    normalizeToForwardSlashes
  );

  const missing = declared.filter((f) => !exists(resolveRepoFile(repoRoot, f)));
  if (missing.length) {
    throw new Error(
      `Declared webRouteFile(s) missing on disk:\n` +
        missing.map((f) => `- ${f}`).join("\n")
    );
  }
}

function assertDeclaredPageRoutesExist(repoRoot, manifest) {
  const declared = getDeclaredPageRouteFiles(manifest).map(
    normalizeToForwardSlashes
  );
  const missing = declared.filter((f) => !exists(resolveRepoFile(repoRoot, f)));
  if (missing.length) {
    throw new Error(
      `Declared page route file(s) missing on disk:\n` +
        missing.map((f) => `- ${f}`).join("\n")
    );
  }
}

function assertBackendPathsExist(repoRoot, contractId, backend) {
  const backendFile = resolveRepoFile(repoRoot, backend.file);
  if (!exists(backendFile)) {
    throw new Error(`[${contractId}] Backend file missing: ${backend.file}`);
  }

  const src = readText(backendFile);
  if (
    !src.includes(`prefix="${backend.routerPrefix}"`) &&
    !src.includes(`prefix='${backend.routerPrefix}'`)
  ) {
    throw new Error(
      `[${contractId}] Backend router prefix not found in ${backend.file}: ${backend.routerPrefix}`
    );
  }

  for (const p of backend.paths) {
    // In Python code this should appear as @router.get("/x") etc (path only, prefix is separate)
    if (!src.includes(`"${p}"`) && !src.includes(`'${p}'`)) {
      throw new Error(
        `[${contractId}] Backend path not found in ${backend.file}: ${p}`
      );
    }
  }
}

function assertNativeExists(repoRoot, contractId, native) {
  const filesToCheck = [
    native.tsPluginFile,
    native.iosPluginFile,
    native.androidPluginFile,
  ].filter(Boolean);

  for (const f of filesToCheck) {
    const full = resolveRepoFile(repoRoot, f);
    if (!exists(full)) {
      throw new Error(`[${contractId}] Native/TS plugin file missing: ${f}`);
    }
  }

  if (native.requiredMethodNames?.length && native.tsPluginFile) {
    const ts = readText(resolveRepoFile(repoRoot, native.tsPluginFile));
    for (const m of native.requiredMethodNames) {
      if (!ts.includes(m)) {
        throw new Error(
          `[${contractId}] Expected method name missing in ${native.tsPluginFile}: ${m}`
        );
      }
    }
  }

  if (native.fallbackPolicy && native.fallbackPolicy !== "fail_closed") {
    throw new Error(
      `[${contractId}] Invalid fallbackPolicy "${native.fallbackPolicy}" (must be "fail_closed")`
    );
  }
}

function assertFileListExists(repoRoot, contractId, label, files) {
  for (const file of files || []) {
    const full = resolveRepoFile(repoRoot, file);
    if (!exists(full)) {
      throw new Error(`[${contractId}] Missing ${label} file: ${file}`);
    }
  }
}

function buildContractIndex(manifest) {
  const index = new Map();
  for (const contract of manifest.contracts || []) {
    if (!contract.id) continue;
    index.set(contract.id, contract);
  }
  return index;
}

function buildDeclaredWebRouteSet(manifest) {
  return new Set(
    getDeclaredWebRouteFiles(manifest).map(normalizeToForwardSlashes)
  );
}

function assertContractIdsExist({
  contractId,
  contractIndex,
  ids,
  label,
  nativeRequired,
  backendRequired,
}) {
  for (const id of ids || []) {
    const contract = contractIndex.get(id);
    if (!contract) {
      throw new Error(`[${contractId}] Unknown ${label} contract id: ${id}`);
    }
    if (nativeRequired && !contract.native) {
      throw new Error(
        `[${contractId}] ${label} contract "${id}" is missing native block`
      );
    }
    if (backendRequired && !contract.backend) {
      throw new Error(
        `[${contractId}] ${label} contract "${id}" is missing backend block`
      );
    }
  }
}

function assertPageContracts(repoRoot, manifest) {
  const contractIndex = buildContractIndex(manifest);
  const declaredWebRoutes = buildDeclaredWebRouteSet(manifest);
  const seenPageFiles = new Set();

  for (const c of manifest.pageContracts || []) {
    if (!c.id) {
      throw new Error(`pageContracts entry missing id`);
    }
    if (!c.pageFile) {
      throw new Error(`[${c.id}] pageContracts entry missing pageFile`);
    }
    if (seenPageFiles.has(c.pageFile)) {
      throw new Error(
        `[${c.id}] duplicate pageFile in pageContracts: ${c.pageFile}`
      );
    }
    seenPageFiles.add(c.pageFile);

    assertFileListExists(repoRoot, c.id, "component", c.componentFiles);
    assertFileListExists(repoRoot, c.id, "service", c.serviceFiles);
    assertFileListExists(repoRoot, c.id, "web route", c.webRouteFiles);
    assertFileListExists(repoRoot, c.id, "native file", c.nativeFiles);

    for (const routeFile of c.webRouteFiles || []) {
      const normalized = normalizeToForwardSlashes(routeFile);
      if (!declaredWebRoutes.has(normalized)) {
        throw new Error(
          `[${c.id}] webRouteFiles includes undeclared route file: ${routeFile}`
        );
      }
    }

    assertContractIdsExist({
      contractId: c.id,
      contractIndex,
      ids: c.apiContractIds,
      label: "api",
      backendRequired: true,
      nativeRequired: false,
    });
    assertContractIdsExist({
      contractId: c.id,
      contractIndex,
      ids: c.nativeContractIds,
      label: "native",
      backendRequired: false,
      nativeRequired: true,
    });

    for (const dep of c.nativeDependencies || []) {
      assertNativeExists(repoRoot, `${c.id}:native`, dep);
    }
  }
}

function assertStandardRoutesDoNotOwnTopShellSpacing(repoRoot, layoutContract) {
  const forbiddenTokens = [
    "var(--page-top-start",
    "var(--top-content-pad",
    "var(--top-shell-reserved-height",
    "pt-[var(--page-top-start",
    "pt-[calc(var(--top",
    "paddingTop: \"var(--page-top-start",
    "paddingTop: 'var(--page-top-start",
  ];

  for (const entry of layoutContract) {
    if (entry.mode !== "standard" || !entry.shellVerification?.file) {
      continue;
    }

    const filePath = resolveRepoFile(repoRoot, path.join("hushh-webapp", entry.shellVerification.file));
    if (!exists(filePath)) {
      throw new Error(
        `[route-layout:${entry.route}] Missing shell verification file: ${entry.shellVerification.file}`
      );
    }

    const source = readText(filePath);
    const offending = forbiddenTokens.find((token) => source.includes(token));
    if (offending) {
      throw new Error(
        `[route-layout:${entry.route}] Standard routes must rely on provider-owned shell spacing. Remove manual top-shell compensation token "${offending}" from ${entry.shellVerification.file}.`
      );
    }
  }
}

function main() {
  const repoRoot = repoRootFromHere();
  const layoutContract = loadAppRouteLayoutContract(repoRoot);
  const manifestPath = path.join(
    repoRoot,
    "hushh-webapp",
    "route-contracts.json"
  );
  if (!exists(manifestPath)) {
    throw new Error(`Missing manifest: hushh-webapp/route-contracts.json`);
  }

  const manifest = JSON.parse(readText(manifestPath));

  // 0) Declared routes must exist on disk (prevents stale manifest entries)
  assertDeclaredWebRoutesExist(repoRoot, manifest);

  const actualWebRouteFiles = listWebRouteFiles(repoRoot).map((p) =>
    normalizeToForwardSlashes(path.relative(repoRoot, p))
  );

  const declaredWebRouteFiles = new Set(
    getDeclaredWebRouteFiles(manifest).map(normalizeToForwardSlashes)
  );
  const allowlisted = new Set(
    (manifest.allowlistedWebRouteFiles || []).map(normalizeToForwardSlashes)
  );

  // 1) No undeclared Next.js API routes (prevents lying endpoints)
  const undeclared = actualWebRouteFiles.filter(
    (f) => !declaredWebRouteFiles.has(f) && !allowlisted.has(f)
  );
  if (undeclared.length) {
    throw new Error(
      `Undeclared Next.js API routes found (add to route-contracts.json or allowlist):\n` +
        undeclared.map((f) => `- ${f}`).join("\n")
    );
  }

  assertDeclaredPageRoutesExist(repoRoot, manifest);

  const actualPageRouteFiles = listPageRouteFiles(repoRoot).map((p) =>
    normalizeToForwardSlashes(path.relative(repoRoot, p))
  );
  const declaredPageRouteFiles = new Set(
    getDeclaredPageRouteFiles(manifest).map(normalizeToForwardSlashes)
  );
  const allowlistedPages = new Set(
    (manifest.allowlistedPageRouteFiles || []).map(normalizeToForwardSlashes)
  );
  const undeclaredPages = actualPageRouteFiles.filter(
    (f) => !declaredPageRouteFiles.has(f) && !allowlistedPages.has(f)
  );
  if (undeclaredPages.length) {
    throw new Error(
      `Undeclared page routes found (add to route-contracts.json pageContracts):\n` +
        undeclaredPages.map((f) => `- ${f}`).join("\n")
    );
  }

  // 2) Validate each contract's backend hints and native/plugin presence
  for (const c of manifest.contracts) {
    if (c.backend) assertBackendPathsExist(repoRoot, c.id, c.backend);
    if (c.native) assertNativeExists(repoRoot, c.id, c.native);
  }

  // 3) Validate page-level runtime contracts
  assertPageContracts(repoRoot, manifest);
  assertStandardRoutesDoNotOwnTopShellSpacing(repoRoot, layoutContract);

  // eslint-disable-next-line no-console
  console.log("OK: route contracts verified (API + page runtime)");
}

main();

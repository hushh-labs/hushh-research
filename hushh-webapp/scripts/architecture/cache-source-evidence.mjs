// Source evidence reader for route cache classification. No cache policy authority.
import fs from "node:fs";
import path from "node:path";

export function readRouteCacheSource(route, contractEntry, { appRoot, pageFileForRoute, read }) {
  const files = new Set();
  const pageFile = pageFileForRoute(route);
  if (pageFile) files.add(pageFile);
  const verificationFile = contractEntry?.shellVerification?.file;
  if (verificationFile) files.add(verificationFile);
  // The canonical root is a route-level chat surface, so include its workspace
  // in the evidence scan. The page is intentionally a thin auth/vault guard;
  // scanning only it would misclassify the root as non-streaming.
  if (
    route === "/" &&
    fs.existsSync(path.join(appRoot, "components/agent/agent-chat-workspace.tsx"))
  ) {
    files.add("components/agent/agent-chat-workspace.tsx");
  }

  if (route === "/one/gmail") {
    for (const file of ["components/gmail/gmail-receipts-page.tsx", "lib/services/mail-receipt-resource-service.ts", "lib/mail/receipt-store.ts"]) files.add(file);
  }
  if (route === "/one/documents/open") {
    for (const file of ["components/consent/hosted-document-reader.tsx", "lib/services/document-hosting-service.ts"]) files.add(file);
  }
  const sources = [];
  for (const relative of files) {
    const absolute = path.join(appRoot, relative);
    if (fs.existsSync(absolute)) {
      sources.push(read(absolute));
    }
  }
  let joined = sources.join("\n\n");
  if (joined.includes("ConnectedSystemDetailClient")) {
    sources.push(
      read(
        path.join(
          appRoot,
          "app/one/connected-systems/[systemId]/connected-system-detail-client.tsx",
        ),
      ),
    );
    joined = sources.join("\n\n");
  }
  if (joined.includes("ConnectedSystemsPanel")) {
    sources.push(
      read(
        path.join(appRoot, "components/profile/connected-systems-panel.tsx"),
      ),
    );
  }
  if (joined.includes("FeedPage")) {
    sources.push(read(path.join(appRoot, "components/feed/feed-page.tsx")));
  }
  return sources.join("\n\n");
}

/**
 * A start-fresh account's application owner is not its Firebase UID.
 *
 * Every account created before same-login start fresh has an owner equal to its
 * Firebase UID, so passing `user.uid` where the owner belongs looked correct. For a
 * replacement account the backend refuses that UID with a 403 and owner-keyed
 * stores miss. Owner arguments come from the validated `useAuth().userId`, and a
 * Firebase UID is compared with an owner only through `firebaseUidForOwner`.
 * AuthService identity calls, and the identity bindings below, keep the UID.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SCANNED = ["app", "components", "lib", "hooks"];
const FIREBASE_USER = String.raw`(?:user|currentUser|firebaseUser|authUser|activeUser|getCurrentUser\(\))\??\.uid`;
const OWNER_NAME = String.raw`(?:\w+\.)?(?:ownerId|userId|\w+OwnerId|\w+UserId)`;

const RULES = [
  {
    name: "Firebase UID passed as an owner argument",
    patterns: [
      /\b(?:userId|ownerId|user_id|owner_id)\s*:\s*(?:user|currentUser|firebaseUser|authUser|activeUser)\??\.uid\b/,
      /\b(?!AuthService\b)\w+Service\.\w+\([^)]*\b(?:user|currentUser|firebaseUser|authUser|activeUser)\??\.uid\b/,
    ],
    identityBindings: new Set([
      // The native test harness signs in and reports by Firebase identity.
      "components/app-ui/native-test-bootstrap.tsx",
      // The passkey handoff binds the approving device's identity; both sides must change together.
      "app/one/profile/security/devices/authorize/page.tsx",
      // The native Siri index is compared with the native record's identity binding.
      "components/agent/siri-one-entity-index-publisher.tsx",
    ]),
  },
  {
    name: "Firebase UID compared with an owner",
    patterns: [
      new RegExp(String.raw`\b${FIREBASE_USER}\s*[!=]==?\s*${OWNER_NAME}\b`),
      new RegExp(String.raw`\b${OWNER_NAME}\s*[!=]==?\s*(?:\w+\.)?${FIREBASE_USER}\b`),
    ],
    identityBindings: new Set([
      "components/app-ui/native-test-bootstrap.tsx",
      // Phone admission's UI key and the phone-confirmed deletion proof bind the Firebase identity.
      "app/register-phone/page.tsx",
      "lib/services/phone-deletion-verification.ts",
      // Compares the Firebase UID it captured before the native connector handoff.
      "lib/one/google-connector-auth.ts",
      // Cleanup recovery is keyed by the pending Firebase identity, before any owner is admitted.
      "lib/firebase/auth-context.tsx",
    ]),
  },
];

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "node_modules" ? [] : collectSourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const SOURCES = SCANNED.flatMap((surface) => collectSourceFiles(join(process.cwd(), surface))).map((path) => ({
  file: relative(process.cwd(), path).replaceAll("\\", "/"),
  lines: readFileSync(path, "utf8").split("\n"),
}));

describe("application owner ratchet", () => {
  it.each(RULES)("refuses: $name", ({ patterns, identityBindings }) => {
    const offenders = SOURCES.filter(({ file }) => !identityBindings.has(file)).flatMap(({ file, lines }) =>
      lines.flatMap((line, index) =>
        patterns.some((pattern) => pattern.test(line)) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
      ),
    );

    expect(offenders).toEqual([]);
  });
});

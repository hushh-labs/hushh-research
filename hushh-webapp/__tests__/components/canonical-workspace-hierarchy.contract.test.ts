import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("canonical workspace hierarchy", () => {
  it("keeps nested Profile pages behind the stack-owned shared header", () => {
    const stack = read("components/profile/profile-stack-navigator.tsx");

    expect(stack).toContain("function StackHeader");
    expect(stack).toContain("<PageHeader");
    expect(stack).toContain('data-profile-stack-content="true"');
    expect(stack).not.toContain("<AppPageShell");
  });

  it("uses one concise Consent Center route header at the reading measure", () => {
    const consent = read("components/consent/consent-center-page.tsx");

    expect(consent).toContain('<AppPageShell as="main" width="reading"');
    expect(consent).toContain('eyebrow={pageEyebrow}');
    expect(consent).toContain('title="Consent Center"');
    expect((consent.match(/<PageHeader/g) ?? [])).toHaveLength(1);
  });
});

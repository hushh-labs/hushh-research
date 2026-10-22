/** @vitest-environment jsdom */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

describe("native plugin contract verifier", () => {
  it("keeps the actual passive vault probe outside private input and action authority", () => {
    const source = readFileSync(path.join(process.cwd(), "ios/App/App/NativeTestSupport.swift"), "utf8");
    const script = source.slice(source.indexOf("final class NativeVaultLayoutProbe"))
      .match(/private static let script = """\n([\s\S]*?)\n    """/)?.[1];
    if (!script) throw new Error("Native vault probe script missing");
    document.body.innerHTML = '<div data-vault-unlock-surface><div data-vault-flow-content><input id="unlock-passphrase"><button>Unlock</button><button data-testid="vault-use-passphrase-instead">Passphrase</button></div></div>';
    const input = document.querySelector<HTMLInputElement>("input")!;
    const forbiddenRead = vi.fn(() => { throw new Error("PRIVATE_INPUT_READ"); });
    Object.defineProperty(input, "value", { get: forbiddenRead });
    const operation = vi.fn();
    document.querySelector("button")!.addEventListener("click", operation);
    const documentListeners = vi.spyOn(document, "addEventListener");
    const windowListeners = vi.spyOn(window, "addEventListener");
    const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.querySelector("button") });
    vi.stubGlobal("visualViewport", undefined);
    const sample = (body: string) => new Function(`return ${body.trim()}`)() as Record<string, unknown>;
    try {
      expect(sample(script)).toMatchObject({ presentCount: 1, unlockClicks: 0, unlockAccepted: 0,
        methodClicks: 0, methodPointerUps: 0, passphraseFields: 1, dockActive: false });
      expect(sample(script)).toMatchObject({ unlockClicks: 0, unlockAccepted: 0 });
      expect(forbiddenRead).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      // Negative control: an accidental credential read in this real native
      // script must trip the boundary, not merely disappear from its payload.
      const unsafe = script.replace("return Object.fromEntries", "document.querySelector('#unlock-passphrase').value; return Object.fromEntries");
      expect(() => sample(unsafe)).toThrow("PRIVATE_INPUT_READ");
    } finally {
      for (const [type, listener, options] of documentListeners.mock.calls) document.removeEventListener(type, listener, options);
      for (const [type, listener, options] of windowListeners.mock.calls) window.removeEventListener(type, listener, options);
      documentListeners.mockRestore();
      windowListeners.mockRestore();
      delete (window as unknown as Record<symbol, unknown>)[Symbol.for("hushh.native.vault.public-receipt")];
      vi.unstubAllGlobals();
      if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest);
      else Reflect.deleteProperty(document, "elementFromPoint");
      document.body.innerHTML = "";
    }
  });

  it("validates the checked-in iOS and Android plugin trees", () => {
    const verifierPath = path.join(
      process.cwd(),
      "scripts",
      "native",
      "verify-native-plugin-contracts.mjs",
    );

    expect(() =>
      execFileSync(process.execPath, [verifierPath], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it.each([
    {
      file: "native-workspace.ts",
      before: "  getWorkspaceState(options: NativeWorkspaceIdentity): Promise<NativeWorkspaceReceipt | { valid: false }>;",
      after: "",
      diagnostic: "extra native method(s) not declared in TypeScript: getWorkspaceState",
    },
    {
      file: "native-drawers.ts",
      before: '  applyProfileMemoryScene?: NativeMemoryScenePort["applyProfileMemoryScene"];',
      after: "",
      diagnostic: "extra native method(s) not declared in TypeScript: applyProfileMemoryScene",
    },
    {
      file: "native-workspace.ts",
      before: "export interface NativeWorkspacePort {",
      after: "export interface NativeWorkspacePort {\n  contractNegativeControl(): Promise<void>;",
      diagnostic: "missing method(s): contractNegativeControl",
    },
  ])("rejects inherited/indexed contract drift: $diagnostic", ({ file, before, after, diagnostic }) => {
    // A disposable overlay runs the actual verifier without changing source or
    // duplicating the native trees. Only the mutated TypeScript file is copied.
    const appRoot = process.cwd();
    const overlay = mkdtempSync(path.join(tmpdir(), "hushh-native-contract-"));
    const linkEntries = (source: string, target: string, omit: string) => {
      mkdirSync(target, { recursive: true });
      for (const entry of readdirSync(source)) {
        if (entry !== omit) symlinkSync(path.join(source, entry), path.join(target, entry));
      }
    };
    try {
      linkEntries(appRoot, overlay, "lib");
      linkEntries(path.join(appRoot, "lib"), path.join(overlay, "lib"), "capacitor");
      const ports = path.join(appRoot, "lib/capacitor");
      linkEntries(ports, path.join(overlay, "lib/capacitor"), file);
      const source = readFileSync(path.join(ports, file), "utf8");
      expect(source).toContain(before);
      writeFileSync(path.join(overlay, "lib/capacitor", file), source.replace(before, after));
      let failure: { status?: number; stderr?: string } | undefined;
      try {
        execFileSync(process.execPath, [path.join(appRoot, "scripts/native/verify-native-plugin-contracts.mjs")], {
          cwd: overlay, encoding: "utf8", stdio: "pipe",
        });
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure?.status).toBe(1);
      expect(failure?.stderr).toContain(diagnostic);
    } finally {
      rmSync(overlay, { recursive: true, force: true });
    }
  });
});

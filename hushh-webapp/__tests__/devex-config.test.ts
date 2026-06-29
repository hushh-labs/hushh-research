import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import tsconfig from "../tsconfig.json";

describe("DevEx configuration integrity", () => {
  it("keeps the package typecheck script aligned with the TypeScript project config", () => {
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");

    expect(tsconfig.compilerOptions.noEmit).toBe(true);
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.moduleResolution).toBe("bundler");
    expect(tsconfig.include).toEqual(
      expect.arrayContaining(["app/**/*.ts", "lib/**/*.ts"]),
    );
  });
});

import fs from "node:fs";
import path from "node:path";
import contract from "@/contracts/pkm/internal-path-keys.v1.json";
import { isInternalManifestPath } from "@/lib/pkm/internal-path-keys";

describe("PKM internal-path contract packaging", () => {
  it.each(contract.cases)("agrees with the shared path rule for $path", ({ path, internal }) => {
    expect(isInternalManifestPath(path)).toBe(internal);
  });
  it("keeps the Docker-context mirror byte-for-byte identical to the canonical contract", () => {
    const canonical = path.resolve(
      process.cwd(),
      "../contracts/pkm/internal-path-keys.v1.json",
    );
    const packaged = path.resolve(
      process.cwd(),
      "contracts/pkm/internal-path-keys.v1.json",
    );

    expect(fs.readFileSync(packaged, "utf8")).toBe(
      fs.readFileSync(canonical, "utf8"),
    );
  });
});

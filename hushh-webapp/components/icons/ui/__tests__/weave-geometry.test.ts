import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { weaveFrame, WEAVE_DURATION_MS } from "../weave-geometry";
import approvedFrames from "./weave-approved-frames.json";

const geometry = (html: string) => [...html.matchAll(/<path[^>]+>/g)].map(match => match[0]).join("");

function colouredPaths(progress: number, phase: number) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.innerHTML = weaveFrame(progress, phase);
  return [...svg.querySelectorAll("path")].map(path => `${path.parentElement!.getAttribute("style")}:${path.getAttribute("d")}`);
}

describe("approved Weave motion", () => {
  it("preserves the kit's 1040ms duration and exact geometry across 65 frames", () => {
    expect(WEAVE_DURATION_MS).toBe(1040);
    // Hashes come from the supplied, unmodified icon-engine.js renderer.
    for (const [progress, hash] of Object.entries(approvedFrames)) {
      expect(createHash("sha256").update(geometry(weaveFrame(Number(progress)))).digest("hex")).toBe(hash);
    }
  });

  it("keeps two alternating accent/ink loops on every frame, including split runs", () => {
    for (const phase of [0, 1, 2, 3]) for (let frame = 0; frame <= 64; frame++) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.innerHTML = weaveFrame(frame / 64, phase);
      const groups = [...svg.querySelectorAll("[data-weave-loop]")];
      expect(groups).toHaveLength(4);
      expect(groups.filter(group => group.getAttribute("style")!.includes("accent"))).toHaveLength(2);
      groups.forEach(group => {
        const index = Number(group.getAttribute("data-weave-loop"));
        expect(group.getAttribute("style")).toContain((index + phase) % 2 === 0 ? "--ios-account-accent" : "--ios-account-label");
        expect(group.querySelectorAll("path").length).toBeGreaterThan(0);
      });
    }
  });

  it("has identical coloured geometry and paint order at settling, reset and the next replay", () => {
    for (let cycle = 0; cycle < 4; cycle++) {
      expect(colouredPaths(1, cycle % 4)).toEqual(colouredPaths(0, (cycle + 1) % 4));
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  trackRequestEnd,
  trackRequestStart,
} from "@/lib/motion/api-progress-tracker";

describe("api-progress-tracker", () => {
  it("exports trackRequestStart as a function", () => {
    expect(typeof trackRequestStart).toBe("function");
  });

  it("exports trackRequestEnd as a function", () => {
    expect(typeof trackRequestEnd).toBe("function");
  });

  it("trackRequestStart is callable without throwing", () => {
    expect(() => trackRequestStart()).not.toThrow();
  });

  it("trackRequestEnd is callable without throwing", () => {
    expect(() => trackRequestEnd()).not.toThrow();
  });

  it("allows repeated start calls", () => {
    expect(() => {
      trackRequestStart();
      trackRequestStart();
      trackRequestStart();
    }).not.toThrow();
  });

  it("allows repeated end calls", () => {
    expect(() => {
      trackRequestEnd();
      trackRequestEnd();
      trackRequestEnd();
    }).not.toThrow();
  });

  it("allows interleaved start/end calls", () => {
    expect(() => {
      trackRequestStart();
      trackRequestEnd();
      trackRequestStart();
      trackRequestEnd();
    }).not.toThrow();
  });
});
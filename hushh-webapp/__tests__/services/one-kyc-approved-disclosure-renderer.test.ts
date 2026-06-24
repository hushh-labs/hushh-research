import { describe, expect, it } from "vitest";

import {
  redraftTransformFromInstructions,
} from "@/lib/services/one-kyc-approved-disclosure-renderer";

describe("redraftTransformFromInstructions", () => {
  it("returns all flags disabled when instructions are empty", () => {
    expect(redraftTransformFromInstructions()).toEqual({
      compact: false,
      formal: false,
      bulletList: false,
      structured: false,
      table: false,
      fullDetail: false,
      human: false,
      cleanHeaders: false,
    });
  });

  it("detects human readable and structured requests", () => {
    expect(
      redraftTransformFromInstructions(
        "rewrite this in plain english with clean sections"
      )
    ).toMatchObject({
      human: true,
      structured: true,
      bulletList: true,
    });
  });

  it("detects table formatting requests", () => {
    expect(
      redraftTransformFromInstructions(
        "show this as a table with columns"
      )
    ).toMatchObject({
      table: true,
      structured: false,
      bulletList: true,
    });
  });

  it("detects compact summary requests", () => {
    expect(
      redraftTransformFromInstructions(
        "short concise summary"
      )
    ).toMatchObject({
      compact: true,
    });
  });

  it("detects formal and professional requests", () => {
    expect(
      redraftTransformFromInstructions(
        "professional formal response"
      )
    ).toMatchObject({
      formal: true,
    });
  });

  it("detects full detail requests", () => {
    expect(
      redraftTransformFromInstructions(
        "include all details and everything"
      )
    ).toMatchObject({
      fullDetail: true,
    });
  });

  it("detects header cleanup requests", () => {
    expect(
      redraftTransformFromInstructions(
        "remove duplicate headers and clean headers"
      )
    ).toMatchObject({
      cleanHeaders: true,
    });
  });

  it("supports multiple transformations in a single instruction", () => {
    expect(
      redraftTransformFromInstructions(
        "formal concise table with clean headers"
      )
    ).toMatchObject({
      formal: true,
      compact: true,
      table: true,
      bulletList: true,
      cleanHeaders: true,
    });
  });
});

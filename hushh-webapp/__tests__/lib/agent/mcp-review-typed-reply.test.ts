import { describe, expect, it } from "vitest";
import { isBareReviewReply } from "@/lib/agent/mcp-review-typed-reply";

describe("isBareReviewReply", () => {
  it.each([
    "yes", "y", "yep", "yeah", "yup", "ok", "okay", "sure", "approve", "go ahead",
    "confirm", "do it", "proceed", "yes please", "sounds good", "go for it",
  ])("treats %j as a bare affirmative", (text) => {
    expect(isBareReviewReply(text)).toBe(true);
  });

  it.each([
    "no", "n", "nope", "nah", "cancel", "decline", "stop", "don't", "don’t", "do not", "no thanks", "never mind",
  ])("treats %j as a bare negative", (text) => {
    expect(isBareReviewReply(text)).toBe(true);
  });

  it("ignores case, whitespace and punctuation", () => {
    for (const text of ["YES", "  Yes  ", "yes!", "Yes.", "yes!!!", "...yes", "(yes)", "Go   Ahead", "go-ahead!", "OK?", "\tyes\n"]) {
      expect(isBareReviewReply(text), text).toBe(true);
    }
  });

  it("accepts emoji beside the word and emoji alone", () => {
    for (const text of ["yes 👍", "👍 yes", "yes 🙏", "👍", "👍🏽", "👎", "✅", "❌", "👌!", "no 👎"]) {
      expect(isBareReviewReply(text), text).toBe(true);
    }
  });

  it("folds full-width and accented-compatible forms", () => {
    expect(isBareReviewReply("ＹＥＳ")).toBe(true);
    expect(isBareReviewReply("ｏｋ")).toBe(true);
  });

  it("does not treat other languages or look-alike words as replies", () => {
    for (const text of ["sí", "да", "はい", "是", "yess", "yesterday", "nothing", "okayy", "yés"]) {
      expect(isBareReviewReply(text), text).toBe(false);
    }
  });

  it("rejects empty, blank and punctuation-only text", () => {
    for (const text of ["", "   ", "\n", "!!!", "...", "🙏", "🎉", "?"]) {
      expect(isBareReviewReply(text), text).toBe(false);
    }
  });

  it("rejects anything with an instruction in it", () => {
    for (const text of [
      "try again", "yes but only five", "yes please add all of them", "no, add only the first three",
      "yes and also email them", "ok so what happens next", "cancel the other one",
      "Yes, I approve adding the following 9 connections as contacts in HubSpot.",
    ]) {
      expect(isBareReviewReply(text), text).toBe(false);
    }
  });

  it("rejects a long message that merely starts with yes", () => {
    expect(isBareReviewReply(`yes ${"please ".repeat(20)}`)).toBe(false);
    expect(isBareReviewReply(`yes${"!".repeat(60)}`)).toBe(false);
  });
});

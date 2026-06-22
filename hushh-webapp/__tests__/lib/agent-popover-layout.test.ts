import { describe, expect, it } from "vitest";

import {
  AGENT_POPOVER_PRESET_SIZES,
  clampAgentTriggerPosition,
  clampAgentPopoverSize,
  getDefaultAgentTriggerPosition,
  getAgentPopoverViewportBounds,
  isAgentPopoverSizeMode,
  resolveAgentPopoverSize,
} from "@/lib/agent/agent-popover-layout";

describe("agent popover layout", () => {
  it("accepts only supported size modes", () => {
    expect(isAgentPopoverSizeMode("fullscreen")).toBe(true);
    expect(isAgentPopoverSizeMode("large")).toBe(true);
    expect(isAgentPopoverSizeMode("compact")).toBe(true);
    expect(isAgentPopoverSizeMode("custom")).toBe(true);
    expect(isAgentPopoverSizeMode("dock-left")).toBe(false);
  });

  it("clamps custom size to viewport-safe bounds", () => {
    expect(clampAgentPopoverSize({ width: 50, height: 50 }, 390, 700)).toEqual({
      width: 358,
      height: 520,
    });
    expect(clampAgentPopoverSize({ width: 9999, height: 9999 }, 1440, 900)).toEqual({
      width: 1408,
      height: 868,
    });
  });

  it("resolves presets while preserving custom size", () => {
    expect(resolveAgentPopoverSize("compact", { width: 777, height: 666 })).toEqual(
      AGENT_POPOVER_PRESET_SIZES.compact
    );
    expect(resolveAgentPopoverSize("large", { width: 777, height: 666 })).toEqual(
      AGENT_POPOVER_PRESET_SIZES.large
    );
    expect(resolveAgentPopoverSize("custom", { width: 777, height: 666 })).toEqual({
      width: 777,
      height: 666,
    });
  });

  it("keeps minimums below maximums on small screens", () => {
    const bounds = getAgentPopoverViewportBounds(320, 480);
    expect(bounds.minWidth).toBeLessThanOrEqual(bounds.maxWidth);
    expect(bounds.minHeight).toBeLessThanOrEqual(bounds.maxHeight);
  });

  it("places the floating trigger above bottom chrome by default", () => {
    expect(
      getDefaultAgentTriggerPosition({
        viewportWidth: 430,
        viewportHeight: 932,
        triggerWidth: 44,
        triggerHeight: 44,
        reservedBottom: 188,
        reservedTop: 88,
        safeTop: 47,
        margin: 16,
      })
    ).toEqual({
      x: 370,
      y: 684,
    });
  });

  it("prevents dragging the floating trigger into the bottom chrome", () => {
    expect(
      clampAgentTriggerPosition(
        { x: 386, y: 900 },
        {
          viewportWidth: 430,
          viewportHeight: 932,
          triggerWidth: 44,
          triggerHeight: 44,
          reservedBottom: 188,
          reservedTop: 88,
          safeTop: 47,
          margin: 16,
        }
      )
    ).toEqual({
      x: 370,
      y: 684,
    });
  });

  it("keeps the floating trigger on the right rail", () => {
    expect(
      clampAgentTriggerPosition(
        { x: 20, y: 300 },
        {
          viewportWidth: 430,
          viewportHeight: 932,
          triggerWidth: 44,
          triggerHeight: 44,
          reservedBottom: 188,
          reservedTop: 88,
          safeTop: 47,
          margin: 16,
        }
      )
    ).toEqual({
      x: 370,
      y: 300,
    });
  });

  it("prevents dragging the floating trigger into the top chrome", () => {
    expect(
      clampAgentTriggerPosition(
        { x: 386, y: 12 },
        {
          viewportWidth: 430,
          viewportHeight: 932,
          triggerWidth: 44,
          triggerHeight: 44,
          reservedBottom: 188,
          reservedTop: 88,
          safeTop: 47,
          margin: 16,
        }
      )
    ).toEqual({
      x: 370,
      y: 104,
    });
  });
});

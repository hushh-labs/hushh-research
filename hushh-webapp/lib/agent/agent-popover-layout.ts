export type AgentPopoverSizeMode = "fullscreen" | "large" | "compact" | "custom";

export type AgentPopoverSize = {
  width: number;
  height: number;
};

export type AgentTriggerPosition = {
  x: number;
  y: number;
};

export type AgentTriggerBounds = {
  viewportWidth: number;
  viewportHeight: number;
  triggerWidth: number;
  triggerHeight: number;
  reservedBottom: number;
  reservedTop?: number;
  safeTop?: number;
  margin?: number;
};

export const AGENT_POPOVER_DEFAULT_SIZE_MODE: AgentPopoverSizeMode = "fullscreen";

export const AGENT_POPOVER_PRESET_SIZES: Record<Exclude<AgentPopoverSizeMode, "fullscreen" | "custom">, AgentPopoverSize> = {
  compact: {
    width: 520,
    height: 620,
  },
  large: {
    width: 1120,
    height: 760,
  },
};

export const AGENT_POPOVER_STORAGE_KEYS = {
  mode: "hushh.agent.popover.sizeMode",
  customSize: "hushh.agent.popover.customSize",
  triggerPosition: "hushh.agent.popover.triggerPosition",
} as const;

const DEFAULT_TRIGGER_MARGIN = 16;

export function isAgentPopoverSizeMode(value: unknown): value is AgentPopoverSizeMode {
  return value === "fullscreen" || value === "large" || value === "compact" || value === "custom";
}

export function getAgentPopoverViewportBounds(viewportWidth: number, viewportHeight: number) {
  const maxWidth = Math.max(320, viewportWidth - 32);
  const maxHeight = Math.max(360, viewportHeight - 32);

  return {
    minWidth: Math.min(420, maxWidth),
    maxWidth,
    minHeight: Math.min(520, maxHeight),
    maxHeight,
  };
}

export function clampAgentPopoverSize(
  size: AgentPopoverSize,
  viewportWidth: number,
  viewportHeight: number
): AgentPopoverSize {
  const bounds = getAgentPopoverViewportBounds(viewportWidth, viewportHeight);
  return {
    width: Math.round(Math.min(bounds.maxWidth, Math.max(bounds.minWidth, size.width))),
    height: Math.round(Math.min(bounds.maxHeight, Math.max(bounds.minHeight, size.height))),
  };
}

export function resolveAgentPopoverSize(
  mode: AgentPopoverSizeMode,
  customSize: AgentPopoverSize
): AgentPopoverSize {
  if (mode === "compact" || mode === "large") {
    return AGENT_POPOVER_PRESET_SIZES[mode];
  }
  return customSize;
}

export function getDefaultAgentTriggerPosition(bounds: AgentTriggerBounds): AgentTriggerPosition {
  const margin = bounds.margin ?? DEFAULT_TRIGGER_MARGIN;
  return clampAgentTriggerPosition(
    {
      x: bounds.viewportWidth - bounds.triggerWidth - margin,
      y:
        bounds.viewportHeight -
        bounds.reservedBottom -
        bounds.triggerHeight -
        margin,
    },
    bounds
  );
}

export function clampAgentTriggerPosition(
  position: AgentTriggerPosition,
  bounds: AgentTriggerBounds
): AgentTriggerPosition {
  const margin = bounds.margin ?? DEFAULT_TRIGGER_MARGIN;
  const reservedTop = Math.max(0, bounds.reservedTop ?? 0);
  const safeTop = Math.max(0, bounds.safeTop ?? 0);
  const railX = Math.max(margin, bounds.viewportWidth - bounds.triggerWidth - margin);
  const minY = Math.max(safeTop, reservedTop) + margin;
  const maxY = Math.max(
    minY,
    bounds.viewportHeight - bounds.reservedBottom - bounds.triggerHeight - margin
  );

  return {
    x: Math.round(railX),
    y: Math.round(Math.min(maxY, Math.max(minY, position.y))),
  };
}

"use client";

type VoiceMetricPayload = {
  metric: string;
  value: number;
  turnId: string;
  tags?: Record<string, string | number | boolean | null | undefined>;
};

export function createVoiceTurnId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `vturn_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  const random = Math.random().toString(16).slice(2, 10);
  return `vturn_${Date.now().toString(16)}${random}`;
}

export function logVoiceMetric(payload: VoiceMetricPayload): void {
  const normalizedTags: Record<string, string | number | boolean> = {};
  Object.entries(payload.tags || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    normalizedTags[key] = value;
  });
  const event = {
    event: "kai_voice_metric",
    metric: payload.metric,
    value: payload.value,
    turn_id: payload.turnId,
    tags: normalizedTags,
  };
  console.info("[KAI_VOICE_METRIC]", event);
}

export const REACTION_LABELS = {
  "❤️": "red heart", "🤍": "white heart", "😂": "face with tears of joy",
  "🎉": "party popper", "🫶": "heart hands", "💛": "yellow heart",
  "👍": "thumbs up", "🔥": "fire", "😮": "surprised face", "✅": "check mark",
  "🍕": "pizza", "☕": "coffee", "🍰": "cake", "🍣": "sushi",
  "🍜": "noodles", "🍦": "ice cream", "🌮": "taco", "🍝": "pasta",
  "✈️": "airplane", "🏖️": "beach", "🏔️": "mountain", "🗼": "tower",
  "🗽": "Statue of Liberty", "🏕️": "camping", "🎸": "guitar", "🎹": "piano",
  "🎨": "art", "📚": "books", "🎮": "video game", "⚽": "soccer",
  "🏀": "basketball", "🎾": "tennis", "🏃": "running", "🚴": "cycling",
  "🐶": "dog", "🐱": "cat", "🌸": "blossom", "🌱": "seedling",
  "🎂": "birthday cake", "🎓": "graduation", "💍": "ring", "🏠": "house",
} as const;

export type AgentMessageReaction = { emoji: keyof typeof REACTION_LABELS; actor: "agent" };

export function parseAgentMessageReaction(value: unknown): AgentMessageReaction | null {
  if (!value || typeof value !== "object") return null;
  const reaction = value as Record<string, unknown>;
  if (reaction.actor !== "agent" || typeof reaction.emoji !== "string" ||
      !Object.prototype.hasOwnProperty.call(REACTION_LABELS, reaction.emoji)) return null;
  return { emoji: reaction.emoji as AgentMessageReaction["emoji"], actor: "agent" };
}

export const REACTION_TOOL_NAME = "react_to_message" as const;
export type MessageReactionResult = { reaction: AgentMessageReaction; clientMessageId?: string };

/** Only complete server-marked tool results enter presentation state. */
export function parseMessageReaction(content: unknown): MessageReactionResult | null {
  let value = content;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.status !== "shown") return null;
  const reaction = parseAgentMessageReaction({ emoji: result.emoji, actor: "agent" });
  if (!reaction) return null;
  if (result.clientMessageId !== undefined &&
      (typeof result.clientMessageId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(result.clientMessageId))) return null;
  return { reaction, ...(typeof result.clientMessageId === "string" ? { clientMessageId: result.clientMessageId } : {}) };
}

export function attachMessageReaction<T extends {id: string; role: string; reaction?: AgentMessageReaction | null}>(
  messages: T[], targetId: string, reaction: AgentMessageReaction,
): T[] {
  const target = messages.find(message => message.id === targetId && message.role === "user");
  if (!target || target.reaction) return messages;
  return messages.map(message => message === target ? { ...message, reaction } : message);
}

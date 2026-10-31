"""Bounded presentation metadata; no routing or action authority."""

from typing import Literal, TypedDict


class AgentMessageReaction(TypedDict):
    emoji: str
    actor: Literal["agent"]


REACTION_EMOJIS = frozenset(
    {
        "❤️",
        "🤍",
        "😂",
        "🎉",
        "🫶",
        "💛",
        "👍",
        "🔥",
        "😮",
        "✅",
        "🍕",
        "☕",
        "🍰",
        "🍣",
        "🍜",
        "🍦",
        "🌮",
        "🍝",
        "✈️",
        "🏖️",
        "🏔️",
        "🗼",
        "🗽",
        "🏕️",
        "🎸",
        "🎹",
        "🎨",
        "📚",
        "🎮",
        "⚽",
        "🏀",
        "🎾",
        "🏃",
        "🚴",
        "🐶",
        "🐱",
        "🌸",
        "🌱",
        "🎂",
        "🎓",
        "💍",
        "🏠",
    }
)


def normalize_reaction(value: object) -> AgentMessageReaction | None:
    if not isinstance(value, dict) or value.get("actor") != "agent":
        return None
    emoji = value.get("emoji")
    if not isinstance(emoji, str) or emoji not in REACTION_EMOJIS:
        return None
    return {"emoji": emoji, "actor": "agent"}

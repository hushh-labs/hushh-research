"""Literal assembly for explicitly spelled name fields, never name interpretation.

The model owns the order, separators and correction target. A spelling part is
one complete word of Latin letters/digits; ordinary literal text keeps Unicode
and punctuation. Adapters retain their existing identity and approval policy.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class NamePart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["literal", "spelled"]
    text: str = Field(default="", description="Literal text, including word spaces.")
    characters: list[str] = Field(
        default_factory=list,
        description="Spelled word: ordered single Latin letters/digits.",
    )

    @model_validator(mode="after")
    def _one_source(self) -> NamePart:
        if self.type == "literal":
            if self.characters or len(self.text) > 120:
                raise ValueError("a literal part needs only text, at most 120 characters")
        elif self.text or not self.characters:
            raise ValueError("a spelled part needs only its character units")
        elif len(self.characters) > 40 or any(
            len(char) != 1 or not char.isascii() or not char.isalnum() for char in self.characters
        ):
            raise ValueError("a spelled part needs 1-40 single Latin letters or digits")
        return self


def spelled_part_words(parts: list[NamePart] | None) -> list[str]:
    """Accepted spelling is provenance itself; no second annotation is needed."""
    return ["".join(part.characters or []) for part in parts or [] if part.type == "spelled"]


def render_name_input(value: Any, parts: list[NamePart] | None) -> str:
    """Render the explicitly selected source; never overwrite a supplied name.

    Whitespace normalization matches the Circle service. Field adapters apply
    their own final length bound after rendering.
    """
    if parts is not None:
        if value not in (None, ""):
            raise ValueError("supply the name or its parts, never both")
        value = "".join(
            part.text if part.type == "literal" else "".join(part.characters or [])
            for part in parts
        )
    if not isinstance(value, str):
        raise ValueError("supply a name or its parts")
    return " ".join(value.split())

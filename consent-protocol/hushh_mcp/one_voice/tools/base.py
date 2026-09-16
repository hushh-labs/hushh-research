"""Tool contract for One Live Voice.

Rules encoded here, not in prose:

* A tool is bound to exactly one generated gateway ``action_id``; the
  registry test fails when the id does not exist in the gateway.
* ``ToolPolicy`` decides whether a call executes now, needs a spoken
  confirmation after the card was shown, or needs a tap receipt.
* Person and circle arguments are canonical ids (``PersonRef``/``CircleRef``)
  and must already be present in the conversation's :class:`EntityContext`;
  a spoken name can never be an argument to a mutation.
* Every result carries ``status`` from a small, tool-specific vocabulary plus
  ``spoken_facts`` -- the sentences the model may state verbatim. Pending
  states (``confirmation_required``, ``position_publish_pending``,
  ``navigation_dispatched``) are never success.
* The host validates ids, schemas, and authority and returns typed refusals.
  It never re-picks a tool, classifies transcripts, or auto-selects a person
  (AGENTS.md "no second decision-maker").
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ENTITY_CONTEXT_TTL_SECONDS = 2 * 60 * 60


class ToolPolicy(str, Enum):
    read = "read"
    direct = "direct"
    confirm_voice = "confirm_voice"
    confirm_tap = "confirm_tap"

    @property
    def needs_confirmation(self) -> bool:
        return self in {ToolPolicy.confirm_voice, ToolPolicy.confirm_tap}

    @property
    def tier(self) -> str | None:
        if self is ToolPolicy.confirm_voice:
            return "voice"
        if self is ToolPolicy.confirm_tap:
            return "tap"
        return None


class ToolInput(BaseModel):
    """Base for every tool's arguments. Unknown fields are refused so the model
    cannot smuggle a free-text name past a typed id slot."""

    model_config = ConfigDict(extra="forbid")


class PersonRef(BaseModel):
    """A canonical person reference. Only ids, never names."""

    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(
        min_length=1,
        max_length=128,
        description="Canonical user id from resolve_person/confirm_person.",
    )


class CircleRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    circle_id: str = Field(
        min_length=36,
        max_length=36,
        description="Canonical circle id from list_circles/confirm_circle.",
    )


Needs = Literal[
    "confirmation",
    "disambiguation",
    "repeat_name",
    "client_step",
    "unsupported",
    "setup",
    "consent",
    "invite",
]


class ToolResult(BaseModel):
    """Every tool output inherits this. ``status`` is the outcome vocabulary."""

    model_config = ConfigDict(extra="allow")
    status: str
    spoken_facts: list[str] = Field(default_factory=list)
    needs: Needs | None = None
    reason_code: str | None = None
    ui_refresh: list[str] = Field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


class Rejected(ToolResult):
    status: Literal["rejected"] = "rejected"


class Unsupported(ToolResult):
    status: Literal["unsupported"] = "unsupported"
    needs: Needs | None = "unsupported"


class ConfirmationRequired(ToolResult):
    status: Literal["confirmation_required"] = "confirmation_required"
    needs: Needs | None = "confirmation"
    pending_action_id: str
    tier: Literal["voice", "tap"]
    summary: str


class ConfirmedPerson(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str
    public_person_ref: str | None = None
    display_name: str
    photo_url: str | None = None
    relationship: Literal["connected", "pending_outgoing", "pending_incoming", "none", "self"] = (
        "none"
    )
    has_location_key: bool = False
    phone_verified: bool = False
    confirmed_at: str

    def spoken(self) -> str:
        label = {
            "connected": "connected",
            "pending_outgoing": "your request is pending",
            "pending_incoming": "they asked to connect",
            "none": "not connected",
            "self": "you",
        }[self.relationship]
        return f"{self.display_name}, {label}"


class ConfirmedCircle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    circle_id: str
    name: str
    kind: str = "other"
    member_count: int | None = None
    confirmed_at: str


class EntityContext(BaseModel):
    """Per-conversation confirmed entities, keyed by canonical id.

    Only ``confirm_person``/``confirm_circle`` (after a resolve) or a read tool
    that returned an unambiguous canonical record may add entries. Persisted as
    JSONB on the conversation row; entries older than the TTL are dropped.
    """

    model_config = ConfigDict(extra="forbid")
    people: dict[str, ConfirmedPerson] = Field(default_factory=dict)
    circles: dict[str, ConfirmedCircle] = Field(default_factory=dict)
    last_person_user_id: str | None = None
    last_circle_id: str | None = None
    # Candidate ids offered by the most recent resolve_* call. confirm_* only
    # accepts one of these, so the model cannot invent an id.
    offered_person_ids: list[str] = Field(default_factory=list)
    offered_circle_ids: list[str] = Field(default_factory=list)

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)

    def prune(self) -> None:
        cutoff = self._now().timestamp() - ENTITY_CONTEXT_TTL_SECONDS
        for key in list(self.people):
            if datetime.fromisoformat(self.people[key].confirmed_at).timestamp() < cutoff:
                del self.people[key]
        for key in list(self.circles):
            if datetime.fromisoformat(self.circles[key].confirmed_at).timestamp() < cutoff:
                del self.circles[key]
        if self.last_person_user_id not in self.people:
            self.last_person_user_id = None
        if self.last_circle_id not in self.circles:
            self.last_circle_id = None

    def remember_person(self, person: ConfirmedPerson) -> None:
        self.people[person.user_id] = person
        self.last_person_user_id = person.user_id

    def remember_circle(self, circle: ConfirmedCircle) -> None:
        self.circles[circle.circle_id] = circle
        self.last_circle_id = circle.circle_id

    def person(self, user_id: str) -> ConfirmedPerson | None:
        self.prune()
        return self.people.get(user_id)

    def circle(self, circle_id: str) -> ConfirmedCircle | None:
        self.prune()
        return self.circles.get(circle_id)


class ScreenContext(BaseModel):
    """Sanitized ``app_context`` from the client. Never trusted for authority."""

    model_config = ConfigDict(extra="ignore")
    screen_id: str | None = None
    route: str | None = None
    available_action_ids: list[str] = Field(default_factory=list)
    screen_state: dict[str, Any] = Field(default_factory=dict)
    os_location_permission: Literal["unknown", "prompt", "granted", "denied"] = "unknown"


@dataclass
class ToolContext:
    """What a tool handler receives. Authority lives in the token reference,
    resolved and re-validated by the relay before every mutation."""

    user_id: str
    conversation_id: str
    entities: EntityContext
    screen: ScreenContext
    vault_owner_token: str
    firebase_id_token: str | None = None
    # Services may be injected for tests; handlers fall back to real ones.
    services: dict[str, Any] = field(default_factory=dict)

    def service(self, name: str, factory: Callable[[], Any]) -> Any:
        if name not in self.services:
            self.services[name] = factory()
        return self.services[name]


ToolHandler = Callable[[ToolContext, Any], Awaitable[ToolResult]]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    gateway_action_id: str
    policy: ToolPolicy
    input_model: type[ToolInput]
    output_model: type[ToolResult]
    description: str
    handler: ToolHandler
    # Argument field names that must name a confirmed entity in the context.
    person_args: tuple[str, ...] = ()
    circle_args: tuple[str, ...] = ()
    # Client surfaces to refresh after a successful mutation.
    ui_refresh: tuple[str, ...] = ()
    # Requires a fresh Firebase proof at confirmation (people/profile plane).
    firebase_plane: bool = False
    # For confirm_* tools: how the pending card summarizes the action.
    summarize: Callable[[ToolContext, Any], str] | None = None

    def declaration(self) -> dict[str, Any]:
        """Gemini function declaration (JSON-schema parameters, refs inlined)."""
        parameters = inline_schema_refs(self.input_model.model_json_schema())
        parameters.pop("title", None)
        return {
            "name": self.name,
            "description": self.description,
            "parameters_json_schema": parameters,
        }


def inline_schema_refs(schema: dict[str, Any]) -> dict[str, Any]:
    """Resolve local ``$ref``/``$defs`` so the declaration is self-contained.

    Provider function-calling schemas do not reliably honor ``$defs``; nested
    pydantic models (``PersonRef``, ``CircleRef``) are inlined instead.
    """
    defs = dict(schema.get("$defs") or {})

    def _resolve(node: Any) -> Any:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/$defs/"):
                target = defs.get(ref.split("/")[-1], {})
                merged = {**_resolve(target), **{k: v for k, v in node.items() if k != "$ref"}}
                merged.pop("title", None)
                return merged
            return {k: _resolve(v) for k, v in node.items() if k != "$defs"}
        if isinstance(node, list):
            return [_resolve(item) for item in node]
        return node

    result = _resolve(schema)
    return result if isinstance(result, dict) else {}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


__all__ = [
    "CircleRef",
    "ConfirmationRequired",
    "ConfirmedCircle",
    "ConfirmedPerson",
    "ENTITY_CONTEXT_TTL_SECONDS",
    "EntityContext",
    "Needs",
    "PersonRef",
    "Rejected",
    "ScreenContext",
    "ToolContext",
    "ToolHandler",
    "ToolInput",
    "ToolPolicy",
    "ToolResult",
    "ToolSpec",
    "Unsupported",
    "inline_schema_refs",
    "now_iso",
]

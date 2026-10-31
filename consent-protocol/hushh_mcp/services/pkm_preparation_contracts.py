"""Import-safe request and response contracts for owner-reviewed Memory preparation,
and the content-free outcome projection both proposal routes log for each attempt."""

import time
from typing import Literal, get_args

from pydantic import BaseModel, Field, field_validator

# Closed, logging-only codes naming the surface that asked for a preparation.
# They never reach an agent, a prompt or the preview cache. Each stays under
# 24 characters, so the log redactor keeps it readable.
CaptureSource = Literal[
    "agent_chat_auto_capture",
    "app_activity_digest",
    "gmail_receipt_radar",
    "kyc_identity_onboarding",
    "explicit_save",
    "memory_workspace",
    "first_connect_insights",
    "drive_read_review",
    "business_profile_review",
    "profile_research_review",
    "public_profile_claim",
    "unrecognized",
]
_CAPTURE_SOURCES = frozenset(get_args(CaptureSource))


class PKMAgentLabStructureRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=128)
    # Imported personal profiles routinely exceed a short chat-message limit.
    # Keep a hard bound for abuse protection while accepting a complete export.
    message: str = Field(min_length=1, max_length=50000)
    current_domains: list[str] = Field(default_factory=list, max_length=256)
    current_manifests: list[dict] = Field(default_factory=list, max_length=256)
    simulated_state: dict | None = None
    allow_identifier_processing: bool = Field(default=False, strict=True)
    memory_profile: Literal[
        "general",
        "kyc_identity_v1",
        "business_directory_v1",
        "soul_markdown_v1",
        "profile_review_v1",
    ] = "general"
    capture_source: CaptureSource | None = None

    @field_validator("capture_source", mode="before")
    @classmethod
    def _closed_capture_source(cls, value: object) -> str | None:
        # Logging only: an unknown value is recorded as such, never refused, and
        # the raw client string is not kept.
        if value is None:
            return None
        return value if isinstance(value, str) and value in _CAPTURE_SOURCES else "unrecognized"


class PKMAgentLabStructureResponse(BaseModel):
    agent_id: str
    agent_name: str
    model: str
    used_fallback: bool
    intent_used_fallback: bool = False
    structure_used_fallback: bool = False
    error: str | None = None
    intent_frame: dict = Field(default_factory=dict)
    merge_decision: dict = Field(default_factory=dict)
    candidate_payload: dict
    structure_decision: dict
    write_mode: str = "confirm_first"
    primary_json_path: str | None = None
    target_entity_scope: str | None = None
    validation_hints: list[str] = Field(default_factory=list)
    manifest_draft: dict | None = None
    preview_cards: list[dict] = Field(default_factory=list)
    preview_summary: dict = Field(default_factory=dict)
    performance: dict = Field(default_factory=dict)
    context_plan: dict = Field(default_factory=dict)


MEMORY_PROPOSAL_OUTCOME_LOG = (
    "pkm.memory_proposal.outcome route=%s capture_source=%s memory_profile=%s outcome=%s "
    "status=%s chunk_index=%s card_count=%s saveable_count=%s duration_ms=%.0f"
)


def _saveable(card: object) -> bool:
    # Approximates the app's persistable-card filter, for logging only (an upper
    # bound): not do_not_save, not a no_op merge, no fallback and no failed
    # preview stage. Committed fill per source comes from pkm_events.
    if not isinstance(card, dict):
        return False
    merge, drift, hints = (
        card.get("merge_decision"),
        card.get("drift_flags"),
        card.get("validation_hints"),
    )
    merge = merge if isinstance(merge, dict) else {}
    drift = drift if isinstance(drift, dict) else {}
    hints = hints if isinstance(hints, list) else []
    return (
        card.get("write_mode") != "do_not_save"
        and (card.get("merge_mode") or merge.get("merge_mode")) != "no_op"
        and drift.get("fallback_used") is not True
        and "preview_generation_failed" not in hints
    )


_UNAVAILABLE_OUTCOMES = {
    # A closed map from known 503 codes; any other 503 is "unavailable", the
    # failed-preparation outcome. Codes themselves are never logged.
    "PKM_SHARING_IMPACT_UNAVAILABLE": "impact_unavailable",
    "OWNER_AI_SELECTION_UNAVAILABLE": "model_unselected",
    "POD_MEMORY_MODEL_UNAVAILABLE": "model_unselected",
    # After admission only: a provider error or the 150 s command budget running out.
    "COMMAND_PROVIDER_UNAVAILABLE": "provider_unavailable",
    "POD_DRAINING": "admission_refused",
    "COMMAND_HUB_AUTHORITY_UNAVAILABLE": "admission_refused",
}


def _outcome(
    status_code: int, error_code: object, response: object, saveable: int, admitted: bool | None
) -> str:
    if status_code == 0:
        return "cancelled"
    if status_code == 503:
        if error_code == "COMMAND_PROVIDER_UNAVAILABLE" and admitted is False:
            # The pod's shared command queue ran out of time before admitting the
            # request, so no provider was called.
            return "queue_timeout"
        known = _UNAVAILABLE_OUTCOMES.get(error_code) if isinstance(error_code, str) else None
        return known or "unavailable"
    if status_code in (401, 403, 409, 429):
        return "refused"
    if status_code != 200:
        return "failed"
    summary = getattr(response, "preview_summary", None)
    if getattr(response, "used_fallback", False) is True or getattr(response, "error", None):
        return "degraded"
    if isinstance(summary, dict) and summary.get("split_recommended") is True:
        return "split_needed"
    return "saveable" if saveable else "nothing_durable"


def memory_proposal_outcome_args(
    *,
    route: str,
    request: object,
    status_code: int,
    response: object,
    error_code: object,
    chunk_index: object,
    started_at: float,
    admitted: bool | None = None,
) -> tuple:
    """Closed codes and counts for MEMORY_PROPOSAL_OUTCOME_LOG; never text or ids.

    It runs in a finally block, so it never raises and never changes the response.
    ``admitted`` is whether the pod's command admission let the request in.
    """
    try:
        cards = getattr(response, "preview_cards", None) if status_code == 200 else None
        cards = cards if isinstance(cards, list) else []
        saveable = sum(1 for card in cards if _saveable(card))
        outcome = _outcome(status_code, error_code, response, saveable, admitted)
        text = str(chunk_index)
        # ASCII digits only: "²" passes isdigit() but int() refuses it.
        index = int(text) if text.isascii() and text.isdigit() and len(text) <= 4 else 0
        return (
            route,
            getattr(request, "capture_source", None) or "unspecified",
            getattr(request, "memory_profile", "general"),
            outcome,
            status_code,
            index,
            len(cards),
            saveable if outcome == "saveable" else 0,
            (time.perf_counter() - started_at) * 1000,
        )
    except Exception:
        return (route, "unspecified", "general", "failed", status_code, 0, 0, 0, 0.0)

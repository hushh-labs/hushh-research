"""Which provider, model and credential mode serve one pod request, decided together.

``pod_turn._resolve_runtime_mode`` names the mode. On the owner's Azure the mode
alone is not enough: the deployment IS the model. A door that paired
``user_azure_mi`` with the manifest's Gemini either fell into a Hussh-managed
builder (private commands) or refused every build (agent-chat, the close-time
memory review). So every door that runs a model on this pod takes all three from
``pod_turn._resolve_turn_target``, which ends in ``turn_target`` here.

The owner's sealed "Bring your own AI" selection (``pod_ai_selection``) is decided
here too, ahead of all of that: ``owner_selected_turn`` returns the target AND the
request carrying the stored key, because a door that took one without the other
would run the person's chosen model on somebody else's credential.
"""

from __future__ import annotations

import logging
from typing import TypeVar

from fastapi import HTTPException
from pydantic import BaseModel

from hushh_mcp.runtime_providers import azure_openai

logger = logging.getLogger(__name__)

#: ``(provider, model, runtime_mode)`` for one request.
TurnTarget = tuple[str, str, str]
_Request = TypeVar("_Request", bound=BaseModel)
#: The mode a sealed selection runs in: the owner's own key, which the pod holds.
OWNER_SELECTION_MODE = "byok"


def _topology_invalid() -> HTTPException:
    return HTTPException(status_code=503, detail={"code": "AZURE_MODEL_TOPOLOGY_INVALID"})


def owner_azure_model() -> tuple[str, str] | None:
    """(provider, deployment) of this pod's own Azure model; None when none is rendered.

    A half-rendered or malformed topology refuses with a typed 503. It never reads as
    "no Azure here", which would let the caller fall through toward a managed mode.
    """
    try:
        return azure_openai.owner_azure_model()
    except azure_openai.AzureOpenAITopologyInvalid:
        logger.warning("pod_turn.azure_model_topology_invalid")
        raise _topology_invalid() from None


def turn_target(provider: str, model: str, mode: str) -> TurnTarget:
    """The target once ``mode`` is decided.

    On ``user_azure_mi`` the owner's deployment replaces the manifest's model, for One
    and for every specialist that inherits the head's provider. Every other mode keeps
    the provider and model it was given.
    """
    if mode != azure_openai.USER_AZURE_MI_MODE:
        return provider, model, mode
    owner = owner_azure_model()
    if owner is None:
        # The mode was chosen from a topology this process no longer carries.
        raise _topology_invalid()
    return owner[0], owner[1], mode


def owner_selected_turn(
    payload: _Request, provider: str, model: str
) -> tuple[_Request, TurnTarget] | None:
    """(request carrying the stored key, target) for the owner's selection; None without one.

    A stored selection is the person's configuration and wins over every other path
    (a per-turn key, the owner's Azure, user ADC, managed), with no fallback. An
    explicit Puppy turn names the owner's own device for that one turn and keeps it.
    ``model`` is the manifest's Gemini model, which a Gemini selection with no model
    of its own runs on. An unreadable selection is a typed 503, never "no selection".
    """
    if provider == "puppy":
        return None
    from hushh_mcp.services.pod_ai_selection import (  # noqa: PLC0415
        AiSelectionUnavailable,
        active_ai_selection,
    )
    from hushh_mcp.services.pod_ai_selection_check import selection_model  # noqa: PLC0415

    try:
        selection = active_ai_selection()
    except AiSelectionUnavailable:
        logger.warning("pod_turn.ai_selection_unreadable")
        raise HTTPException(
            status_code=503, detail={"code": "OWNER_AI_SELECTION_UNAVAILABLE"}
        ) from None
    if selection is None:
        return None
    owned = payload.model_copy(
        update={
            "runtime_credential": selection.api_key,
            "runtime_credential_transport": selection.transport or "developer_api",
            "vertex_project": selection.vertex_project,
            "vertex_location": selection.vertex_location,
        }
    )
    target_model = selection_model(selection.provider, selection.model, gemini_default=model)
    return owned, (selection.provider, target_model, OWNER_SELECTION_MODE)


def owner_ai_refusal(exc: BaseException, provider: str) -> dict[str, str] | None:
    """The typed refusal when the owner's provider refused their stored key mid-turn.

    ``OWNER_AI_KEY_REFUSED`` or ``OWNER_AI_QUOTA_EXCEEDED`` with the provider's name,
    and the failure is noted for the owner's status read. None for every other
    failure, and for any turn not running on the stored selection.
    """
    from hushh_mcp.services.pod_ai_selection import (  # noqa: PLC0415
        current_ai_selection,
        note_ai_selection_failure,
    )
    from hushh_mcp.services.pod_ai_selection_check import provider_refusal  # noqa: PLC0415

    selection = current_ai_selection()
    if selection is None or selection.provider != provider:
        return None
    code = provider_refusal(exc)
    if code is None:
        return None
    note_ai_selection_failure(code)
    logger.info("pod_turn.owner_ai_refused provider=%s code=%s", provider, code)
    return {"code": f"OWNER_AI_{code}", "provider": provider}

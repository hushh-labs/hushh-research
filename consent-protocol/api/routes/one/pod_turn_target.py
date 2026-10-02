"""Which provider, model and credential mode serve one pod request, decided together.

``pod_turn._resolve_runtime_mode`` names the mode. On the owner's Azure the mode
alone is not enough: the deployment IS the model. A door that paired
``user_azure_mi`` with the manifest's Gemini either fell into a Hussh-managed
builder (private commands) or refused every build (agent-chat, the close-time
memory review). So every door that runs a model on this pod takes all three from
``pod_turn._resolve_turn_target``, which ends in ``turn_target`` here.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException

from hushh_mcp.runtime_providers import azure_openai

logger = logging.getLogger(__name__)

#: ``(provider, model, runtime_mode)`` for one request.
TurnTarget = tuple[str, str, str]


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

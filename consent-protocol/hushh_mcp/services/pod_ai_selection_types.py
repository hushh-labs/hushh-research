"""Typed owner AI selection and its sealed-log decoding."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AiSelection:
    """The owner's active choice. The key is never included in its repr."""

    provider: str
    model: Optional[str]
    api_key: str = field(repr=False)
    transport: Optional[str]
    vertex_project: Optional[str]
    vertex_location: Optional[str]
    issued_at_ms: int
    selection_id: str
    checked_at_ms: int
    azure_endpoint: Optional[str] = None


def selection_from_payload(payload: Mapping[str, Any]) -> Optional[AiSelection]:
    """A malformed selection is never half-used."""
    try:
        provider = str(payload["provider"])
        api_key = str(payload["apiKey"])
        if not provider or not api_key:
            return None
        return AiSelection(
            provider=provider,
            model=payload.get("model") or None,
            api_key=api_key,
            transport=payload.get("transport") or None,
            vertex_project=payload.get("vertexProject") or None,
            vertex_location=payload.get("vertexLocation") or None,
            issued_at_ms=int(payload["issuedAtMs"]),
            selection_id=str(payload.get("selectionId") or ""),
            checked_at_ms=int(payload.get("checkedAtMs") or 0),
            azure_endpoint=payload.get("azureEndpoint") or None,
        )
    except (KeyError, TypeError, ValueError):
        logger.warning("pod_ai_selection.stored_record_ignored")
        return None

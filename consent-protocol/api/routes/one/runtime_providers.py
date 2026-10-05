"""Which AI providers a person may bring to their private agent: the server-owned catalog.

``GET /api/one/runtime/providers`` (contract C5). The app renders this list rather than
its own, so offering a new provider later is a server change: a row here, plus the
agent advertising the matching ``agentCapability`` in its ``aiSelection``
(``pod_capabilities``). A provider the person's agent does not advertise is one the app
offers through an owner-approved update first, never one it lets them pick into a
failure. Static, read-only and identical for every signed-in caller; same prefix and
authentication as ``runtime.py``, in its own module so that file does not grow.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from api.middleware import require_firebase_auth
from hushh_mcp.runtime_providers.owner_openai import OWNER_OPENAI_DEFAULT_MODEL

router = APIRouter(prefix="/api/one/runtime", tags=["One runtime configuration"])

PROVIDER_CATALOG_VERSION = 1


def provider_catalog() -> dict[str, Any]:
    """The catalog body. ``agentCapability`` names the provider id an agent advertises."""
    return {
        "version": PROVIDER_CATALOG_VERSION,
        "providers": [
            {
                "id": "gemini",
                "name": "Google Gemini",
                "availability": "available",
                "methods": ["own_key"],
                "agentCapability": "gemini",
            },
            {
                "id": "openai",
                "name": "OpenAI",
                "availability": "available",
                "methods": ["own_key"],
                "agentCapability": "openai",
                "defaultModel": OWNER_OPENAI_DEFAULT_MODEL,
            },
            {"id": "anthropic", "name": "Claude", "availability": "coming_soon", "methods": []},
            {"id": "grok", "name": "Grok", "availability": "coming_soon", "methods": []},
        ],
    }


@router.get("/providers")
async def runtime_provider_catalog(
    _firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    return provider_catalog()


__all__ = ["provider_catalog", "router"]

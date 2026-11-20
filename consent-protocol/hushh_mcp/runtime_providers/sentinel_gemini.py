# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Gemini/Vertex client and ADK model routed through out-of-sandbox Sentinel :8082."""

from __future__ import annotations

import os
from typing import Any

import httpx
from google import genai
from google.adk.models import Gemini
from google.genai.types import HttpOptions
from google.oauth2.credentials import Credentials

from hushh_mcp.runtime_settings import (
    pod_model_gateway_token,
    pod_model_gateway_url,
    pod_sentinel_model_enabled,
)

from .gemini_config import resolve_fleet_model_name


def sentinel_vertex_project() -> str:
    """Resolve the Vertex project targeted through Sentinel :8082."""
    raw = (
        os.getenv("HUSSH_SENTINEL_VERTEX_PROJECT") or os.getenv("GOOGLE_CLOUD_PROJECT") or ""
    ).strip()
    if raw:
        return raw
    deploy_env = (os.getenv("HUSHH_DEPLOY_ENV") or os.getenv("ENVIRONMENT") or "").strip().lower()
    return "hushh-pda-uat" if deploy_env == "uat" else "hushh-pda-dev"


def sentinel_vertex_location(location: str | None = None) -> str:
    """Resolve the Vertex region/location targeted through Sentinel :8082."""
    return (
        str(location or os.getenv("HUSSH_SENTINEL_VERTEX_LOCATION") or "global").strip() or "global"
    )


def build_sentinel_genai_client(*, location: str | None = None) -> genai.Client:
    """Build a ``google.genai.Client`` bound directly to Sentinel :8082 with trust_env=False."""
    if not pod_sentinel_model_enabled():
        raise RuntimeError("Sentinel model authority is unavailable")
    gateway_url = pod_model_gateway_url()
    surrogate = pod_model_gateway_token()
    project = sentinel_vertex_project()
    eff_location = sentinel_vertex_location(location)

    # Static surrogate bearer token keeps google-auth away from GCE metadata, while
    # trust_env=False bypasses HTTP(S)_PROXY (:3128) for direct in-cluster :8082 hops.
    creds = Credentials(token=surrogate)
    sync_http = httpx.Client(trust_env=False, timeout=120.0)
    async_http = httpx.AsyncClient(trust_env=False, timeout=120.0)
    http_opts = HttpOptions(
        base_url=gateway_url,
        headers={"Authorization": f"Bearer {surrogate}"},
        httpx_client=sync_http,
        httpx_async_client=async_http,
    )
    return genai.Client(
        vertexai=True,
        project=project,
        location=eff_location,
        credentials=creds,
        http_options=http_opts,
    )


def build_sentinel_gemini_adk_model(
    model: str,
    *,
    vertex_location: str | None = None,
) -> Gemini:
    """Return an ADK ``Gemini`` adapter backed by Sentinel :8082 L7 model gateway."""
    clean_model = resolve_fleet_model_name(str(model or "").strip())
    if not clean_model:
        raise ValueError("Sentinel model identifier is required")
    client: Any = build_sentinel_genai_client(location=vertex_location)
    return Gemini(model=clean_model, client=client)

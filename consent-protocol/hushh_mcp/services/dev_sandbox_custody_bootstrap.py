# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Self-healing Dev Hub sandbox custody bootstrap for Cloud Run consent-protocol (#9744).

Because privileged Cloud Build / deploy scripts in ``scripts/deploy/`` are Main-owned,
routine ``deploy-dev.yml`` runs previously wiped out-of-band Cloud Run env/secret
bindings whenever ``main`` had not yet synced Dev-only sandbox flags. On the ``dev``
Cloud Run ``consent-protocol`` service, the runtime service account already holds
``roles/secretmanager.secretAccessor`` on ``hussh-custody-broker-seal-key`` and
``sandbox-edge-identity-master-key``.

This module self-hydrates missing Dev Hub sandbox custody configuration at Hub
startup strictly when:
  1. Not running in ``pod_mode()``;
  2. ``HUSHH_DEPLOY_ENV == "dev"`` and ``ENVIRONMENT == "dev"``;
  3. ``K_SERVICE == "consent-protocol"`` (excludes commerce previews and local laptops);
  4. ``HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED`` is not explicitly disabled (``0``/``false``).

UAT, staging, production, commerce preview services, private pods, local development,
and unit tests (unless ``allow_in_tests=True``) are 100% untouched.
"""

from __future__ import annotations

import base64
import http.client
import json
import logging
import os
import urllib.parse
from collections.abc import Callable
from typing import Any

from hushh_mcp.runtime_settings import pod_mode

logger = logging.getLogger(__name__)

_FALSEY = frozenset({"0", "false", "no", "off"})
_SEAL_SECRET_NAME = "hussh-custody-broker-seal-key"  # noqa: S105 - Secret Manager resource id, not a secret value
_MASTER_SECRET_NAME = "sandbox-edge-identity-master-key"  # noqa: S105 - Secret Manager resource id, not a secret value
_GCP_METADATA_HOST = "metadata.google.internal"
_GCP_METADATA_PATH = "/computeMetadata/v1/instance/service-accounts/default/token"


def derive_sibling_edge_gateway_url(consent_public_origin: str) -> str:
    """Derive ``sandbox-edge-gateway`` URL from ``CONSENT_API_PUBLIC_ORIGIN`` without hardcoded hashes."""
    cleaned = str(consent_public_origin or "").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(cleaned)
    if parsed.scheme != "https" or not parsed.netloc.startswith("consent-protocol-"):
        return ""
    suffix = parsed.netloc[len("consent-protocol-") :]
    if not suffix:
        return ""
    return f"https://sandbox-edge-gateway-{suffix}"


def _default_metadata_token_fetcher() -> str:
    conn = http.client.HTTPConnection(_GCP_METADATA_HOST, 80, timeout=2.5)
    try:
        conn.request("GET", _GCP_METADATA_PATH, headers={"Metadata-Flavor": "Google"})
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8")
        if int(resp.status) != 200:
            return ""
        body = json.loads(raw)
        return str(body.get("access_token") or "").strip()
    finally:
        conn.close()


def _default_secret_fetcher(project_id: str, secret_name: str, access_token: str) -> str:
    safe_proj = urllib.parse.quote(project_id.strip(), safe="")
    safe_sec = urllib.parse.quote(secret_name.strip(), safe="")
    path = f"/v1/projects/{safe_proj}/secrets/{safe_sec}/versions/latest:access"
    conn = http.client.HTTPSConnection("secretmanager.googleapis.com", 443, timeout=4.0)
    try:
        conn.request(
            "GET",
            path,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
            },
        )
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8")
        if int(resp.status) != 200:
            return ""
        doc = json.loads(raw)
        b64_data = str(((doc.get("payload") or {}).get("data")) or "").strip()
        if not b64_data:
            return ""
        return base64.b64decode(b64_data).decode("utf-8").strip()
    finally:
        conn.close()


def _default_edge_probe(edge_url: str) -> bool:
    parsed = urllib.parse.urlsplit(f"{edge_url.rstrip('/')}/healthz")
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    conn = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=3.0)
    try:
        conn.request("GET", parsed.path or "/healthz", headers={"Accept": "application/json"})
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8")
        if int(resp.status) != 200:
            return False
        doc = json.loads(raw)
        return isinstance(doc, dict) and doc.get("status") == "edge_gateway_ready"
    finally:
        conn.close()


def bootstrap_dev_hub_sandbox_custody(
    *,
    environ: dict[str, str] | None = None,
    allow_in_tests: bool = False,
    token_fetcher: Callable[[], str] = _default_metadata_token_fetcher,
    secret_fetcher: Callable[[str, str, str], str] = _default_secret_fetcher,
    edge_probe: Callable[[str], bool] = _default_edge_probe,
) -> dict[str, Any]:
    """Hydrate missing Dev Hub sandbox custody settings safely on Cloud Run dev."""
    env = os.environ if environ is None else environ

    if pod_mode():
        return {"bootstrapped": False, "reason": "pod_mode"}
    if not allow_in_tests and env.get("PYTEST_CURRENT_TEST"):
        return {"bootstrapped": False, "reason": "pytest"}

    deploy_env = str(env.get("HUSHH_DEPLOY_ENV") or "").strip().lower()
    runtime_env = str(env.get("ENVIRONMENT") or "").strip().lower()
    k_service = str(env.get("K_SERVICE") or "").strip()
    if deploy_env != "dev" or runtime_env != "dev" or k_service != "consent-protocol":
        return {"bootstrapped": False, "reason": "lane_mismatch"}

    explicit_cutover = str(env.get("HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED") or "").strip().lower()
    if explicit_cutover in _FALSEY:
        return {"bootstrapped": False, "reason": "explicitly_disabled"}

    project_id = str(env.get("GOOGLE_CLOUD_PROJECT") or "").strip()
    consent_origin = str(env.get("CONSENT_API_PUBLIC_ORIGIN") or "").strip().rstrip("/")
    if not project_id or not consent_origin.startswith("https://"):
        return {"bootstrapped": False, "reason": "missing_project_or_origin"}

    edge_url = str(env.get("HUSSH_SANDBOX_EDGE_PUBLIC_URL") or "").strip().rstrip("/")
    if not edge_url:
        edge_url = derive_sibling_edge_gateway_url(consent_origin)
        if not edge_url or not edge_probe(edge_url):
            logger.warning("startup.dev_sandbox_custody_skipped reason=edge_gateway_unverified")
            return {"bootstrapped": False, "reason": "edge_gateway_unverified"}

    seal_key = str(env.get("HUSSH_CUSTODY_BROKER_SEAL_KEY") or "").strip()
    master_key = str(env.get("HUSSH_SANDBOX_IDENTITY_MASTER_KEY") or "").strip()
    if not seal_key or len(master_key) < 32:
        token = token_fetcher()
        if not token:
            logger.warning("startup.dev_sandbox_custody_skipped reason=metadata_token_empty")
            return {"bootstrapped": False, "reason": "metadata_token_empty"}
        if not seal_key:
            seal_key = secret_fetcher(project_id, _SEAL_SECRET_NAME, token)
        if len(master_key) < 32:
            master_key = secret_fetcher(project_id, _MASTER_SECRET_NAME, token)

    if not seal_key or len(master_key) < 32:
        logger.warning("startup.dev_sandbox_custody_skipped reason=secrets_unavailable")
        return {"bootstrapped": False, "reason": "secrets_unavailable"}

    env.setdefault("HUSSH_CUSTODY_BROKER_SEAL_KEY", seal_key)
    env.setdefault("HUSSH_SANDBOX_IDENTITY_MASTER_KEY", master_key)
    env.setdefault("HUSSH_SANDBOX_EDGE_PUBLIC_URL", edge_url)
    env.setdefault(
        "HUSSH_HUB_STORAGE_PREFIX_BASE_URL",
        f"{consent_origin}/api/one/pod/storage-gateway",
    )
    env.setdefault("HUSSH_HUB_STORAGE_TOKEN_PROVIDER", "ace_prefix_bearer")
    env.setdefault("HUSSH_POD_STORAGE_GATEWAY_GCS_BUCKET", "hussh-hosted-pods-dev")
    env.setdefault("HUSSH_SOURCE_POD_RETIREMENT_SWEEP_ENABLED", "true")
    env.setdefault("HUSSH_AGENT_SANDBOX_CUTOVER_ENABLED", "1")

    if environ is None:
        from hushh_mcp.runtime_settings import clear_runtime_settings_caches  # noqa: PLC0415

        clear_runtime_settings_caches()

    logger.info("startup.dev_sandbox_custody_bootstrapped ready=true")
    return {"bootstrapped": True, "edge_url": edge_url}

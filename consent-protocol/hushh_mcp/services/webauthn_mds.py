"""FIDO Metadata Service (MDS) attestation verification for AAL3 (NIST 800-63B / IA-2).

A hardware security key with user verification is AAL3-*candidate* until its
authenticator model (by AAGUID) is verified against the FIDO Metadata Service: the
model must be FIDO-certified and carry no compromise/revocation status. This module
makes that status decision and lets the AAL classifier elevate to real AAL3.

Design (mirrors ``kms_key_resolver``): the status-processing decision is real and
unit-tested; the SOURCE of MDS entries is pluggable. The default source lazy-loads a
**verified** MDS entries file from ``WEBAUTHN_MDS_BLOB_PATH``. Producing that file --
fetching the signed FIDO MDS BLOB and verifying its JWT signature against the FIDO
root certificate -- is the enablement-time step, intentionally kept out of this
module's trust decision; provision + document it before enabling the flag.

Fail-safe: any error, an unknown AAGUID, or a disabled flag never grants AAL3.
"""

from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from typing import Any, Callable, Optional

from hushh_mcp.runtime_settings import webauthn_mds_enabled

logger = logging.getLogger(__name__)

# FIDO MDS statusReport statuses that DISQUALIFY an authenticator (compromise/revocation).
_BAD_STATUSES = frozenset(
    {
        "REVOKED",
        "USER_VERIFICATION_BYPASS",
        "ATTESTATION_KEY_COMPROMISE",
        "USER_KEY_REMOTE_COMPROMISE",
        "USER_KEY_PHYSICAL_COMPROMISE",
    }
)
# Statuses that establish FIDO certification.
_CERTIFIED_STATUSES = frozenset(
    {
        "FIDO_CERTIFIED",
        "FIDO_CERTIFIED_L1",
        "FIDO_CERTIFIED_L1PLUS",
        "FIDO_CERTIFIED_L2",
        "FIDO_CERTIFIED_L2PLUS",
        "FIDO_CERTIFIED_L3",
        "FIDO_CERTIFIED_L3PLUS",
    }
)

# A source maps a lowercase AAGUID -> its MDS entry dict (or None if unknown).
MdsSource = Callable[[str], Optional[dict[str, Any]]]


def evaluate_entry(entry: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Pure decision: is this MDS entry FIDO-certified and uncompromised?

    A single compromise/revocation status disqualifies the model regardless of any
    certification; certification requires at least one FIDO_CERTIFIED* status.
    """
    if not entry:
        return {"verified": False, "reason": "not_found", "status": None}
    reports = entry.get("statusReports") or []
    statuses = [
        str(r.get("status", "")).strip().upper() for r in reports if isinstance(r, dict)
    ]
    bad = next((s for s in statuses if s in _BAD_STATUSES), None)
    if bad:
        return {"verified": False, "reason": "compromised", "status": bad}
    certified = next((s for s in statuses if s in _CERTIFIED_STATUSES), None)
    if certified:
        return {"verified": True, "reason": "certified", "status": certified}
    return {
        "verified": False,
        "reason": "not_certified",
        "status": statuses[-1] if statuses else None,
    }


@lru_cache(maxsize=1)
def _default_mds_index() -> dict[str, dict[str, Any]]:
    """Lazy-load verified MDS entries keyed by lowercase AAGUID from WEBAUTHN_MDS_BLOB_PATH.

    The file MUST already be a verified extract of the FIDO MDS BLOB (JWT signature
    checked against the FIDO root at production time). Unset/missing -> empty index,
    so nothing is elevated.
    """
    path = (os.getenv("WEBAUTHN_MDS_BLOB_PATH") or "").strip()
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError) as exc:
        logger.warning("webauthn MDS index load failed from %s: %s", path, exc)
        return {}
    entries = raw.get("entries", raw) if isinstance(raw, dict) else raw
    index: dict[str, dict[str, Any]] = {}
    if isinstance(entries, list):
        for entry in entries:
            if isinstance(entry, dict) and entry.get("aaguid"):
                index[str(entry["aaguid"]).strip().lower()] = entry
    elif isinstance(entries, dict):
        for aid, entry in entries.items():
            if isinstance(entry, dict):
                index[str(aid).strip().lower()] = entry
    return index


def _default_source(aaguid: str) -> Optional[dict[str, Any]]:
    return _default_mds_index().get(aaguid)


def mds_verified_aaguid(
    aaguid: Optional[str], *, source: Optional[MdsSource] = None
) -> Optional[bool]:
    """Whether the AAGUID is MDS-verified (FIDO-certified + uncompromised).

    Returns ``None`` when MDS verification is disabled, so the AAL classifier keeps
    its honest ``AAL3-candidate``. Returns ``True``/``False`` when enabled. Fail-safe:
    any error resolves to ``False`` and never grants AAL3.
    """
    if not webauthn_mds_enabled():
        return None
    aid = (aaguid or "").strip().lower()
    if not aid:
        return False
    resolve = source or _default_source
    try:
        verdict = evaluate_entry(resolve(aid))
    except Exception as exc:  # noqa: BLE001 -- fail-safe: an MDS error must never grant AAL3
        logger.warning("webauthn MDS verify failed for %s: %s", aid, exc)
        return False
    return bool(verdict["verified"])

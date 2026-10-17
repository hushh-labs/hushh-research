"""Is the consent-audit chain actually signing? One answer, stated explicitly.

THE DEFECT THIS CLOSES. The receipt chain refuses to sign without its own key
(``CONSENT_AUDIT_ED25519_PRIVATE_KEY``), so on a lane that enabled the chain and
never minted the key, every append is dropped and logged. That half was already
correct. The other half was not: ``verify_chain`` over an empty chain answered
``ok: true`` with ``verified_with_kid`` set to the namespace's DEFAULT kid, a key
the process did not hold. An owner, an auditor, or a dashboard reading that
response could not tell "every receipt verified under Ed25519" from "nothing was
ever written because nothing could be signed". Measured on dev 2026-10-06: chain
on, audit key absent, `consent_audit_chain_unsigned` logged on every consent event.

THE CONTRACT.

* Every verification result carries ``signed`` (bool). It is true only when the
  chain is non-empty AND every receipt passed STRICT Ed25519 verification. An
  empty chain is never "signed"; it is nothing, and says why in
  ``unsigned_reason``.
* ``verified_with_kid`` names a kid taken from the verified signatures, never a
  configured default. No receipts means no kid.
* A uat or production HUB process with the chain enabled and no usable audit key
  refuses to start (:func:`enforce_audit_signing_at_startup`). Dev and local log
  loudly and keep serving, because dev is where the key is staged.

Why the startup guard is conditional on the chain being ENABLED: the key signs
nothing else. A lane that has not turned the chain on writes no receipts and
needs no key, and refusing to boot it would block every deploy for a key with no
consumer. A lane that HAS turned it on and cannot sign is the misconfiguration.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from hushh_mcp.consent.token_signing import (
    CONSENT_AUDIT,
    current_kid,
    private_key_configured,
    public_verification_keys,
    sign_payload,
    verify_payload,
)

logger = logging.getLogger(__name__)

#: Lanes where an enabled-but-unsigned chain must stop the process from starting.
STRICT_ENVIRONMENTS = frozenset({"uat", "production"})

_TAG = "ed25519."

REASON_VERIFICATION_FAILED = "verification_failed"
REASON_CHAIN_DISABLED = "chain_disabled"
REASON_SIGNING_KEY_MISSING = "signing_key_missing"
REASON_NO_RECEIPTS = "no_receipts"


class AuditSigningNotConfigured(RuntimeError):
    """A strict lane enabled the chain without a usable signing key."""


_PROBE = "consent-audit-startup-probe"


def _published_map_problem() -> str | None:
    """None when what verifiers are told agrees with what this process signs.

    A usable private key is not enough. A malformed public map makes every
    verify call raise (a 500 per request), and a signing kid absent from the
    published map, or published with the wrong half of the pair, verifies at the
    hub through its derived key while every pod and auditor holding only the map
    rejects every receipt. The round trip runs through the same merged key set
    the chain verifies with, where a published entry wins over the derived one.
    """
    ns = CONSENT_AUDIT
    kid = current_kid(ns)
    material = (os.getenv(ns.public_keys_env) or "").strip()
    try:
        public_verification_keys(ns)  # raises on a malformed map
        if material and kid not in json.loads(material):
            return f"{ns.kid_env} {kid!r} is not in {ns.public_keys_env}"
        signature = sign_payload(_PROBE, hmac_key="", namespace=ns, require_asymmetric=True)
    except RuntimeError as exc:
        return str(exc)
    if not verify_payload(_PROBE, signature, hmac_key="", namespace=ns, require_asymmetric=True):
        return f"{ns.public_keys_env}[{kid!r}] is not the public half of {ns.private_key_env}"
    return None


def _key_problem() -> str | None:
    """None when the audit key can sign and be verified; otherwise what is wrong."""
    try:
        if not private_key_configured(CONSENT_AUDIT):
            return f"{CONSENT_AUDIT.private_key_env} is not set"
    except RuntimeError as exc:  # present but malformed
        return str(exc)
    return _published_map_problem()


def audit_signing_status() -> dict[str, Any]:
    """Whether NEW receipts in this process will be written and signed."""
    from hushh_mcp.runtime_settings import consent_audit_chain_enabled

    configured = _key_problem() is None
    return {
        "chain_enabled": consent_audit_chain_enabled(),
        "signing_key_configured": configured,
        "signing_kid": current_kid(CONSENT_AUDIT) if configured else None,
    }


def signature_kid(signature: str) -> str | None:
    """The kid inside an ``ed25519.<kid>.<sig>`` signature; None for anything else."""
    if not signature.startswith(_TAG):
        return None
    kid = signature[len(_TAG) :].partition(".")[0]
    return kid or None


def _unsigned_reason(ok: bool, status: dict[str, Any]) -> str:
    if not ok:
        return REASON_VERIFICATION_FAILED
    if not status["chain_enabled"]:
        return REASON_CHAIN_DISABLED
    if not status["signing_key_configured"]:
        return REASON_SIGNING_KEY_MISSING
    return REASON_NO_RECEIPTS


def annotate_verification(result: dict[str, Any], receipts: list[dict[str, Any]]) -> dict[str, Any]:
    """Add the explicit signed/unsigned verdict to a chain-verification result.

    ``result`` is the integrity walk's own verdict; ``receipts`` are exactly the
    rows it walked. Nothing here can turn a failed walk into a pass.
    """
    status = audit_signing_status()
    ok = bool(result.get("ok"))
    signed = ok and bool(receipts)
    # Only a passed walk names kids, and never by indexing a row the walk may
    # already have rejected for being malformed.
    kids = (
        sorted({k for r in receipts if (k := signature_kid(str(r.get("signature") or "")))})
        if signed
        else []
    )
    annotated = {
        **result,
        **status,
        "signed": signed,
        "verified_with_kids": kids,
        "verified_with_kid": kids[0] if len(kids) == 1 else None,
    }
    if not signed:
        annotated["unsigned_reason"] = _unsigned_reason(ok, status)
    return annotated


def enforce_audit_signing_at_startup(environment: str | None) -> None:
    """Refuse to start a strict-lane hub whose enabled chain cannot sign.

    A pod is verifier-only by design (it never holds the audit private key) and is
    exempt. Outside uat/production the same condition is logged at ERROR, once per
    process, so dev stays usable while the gap stays visible.
    """
    from hushh_mcp.runtime_settings import consent_audit_chain_enabled, pod_mode

    if pod_mode() or not consent_audit_chain_enabled():
        return
    problem = _key_problem()
    if problem is None:
        return
    lane = (environment or "").strip().lower() or "development"
    message = (
        f"CONSENT_AUDIT_CHAIN_ENABLED is on but the audit chain cannot sign: {problem}. "
        f"No consent receipt will be written. Mint the key with "
        f"`scripts/ops/mint_consent_ed25519_key.py --namespace audit --project <project>` "
        f"and set {CONSENT_AUDIT.alg_env}=ed25519, or turn the chain off."
    )
    if lane in STRICT_ENVIRONMENTS:
        raise AuditSigningNotConfigured(f"Refusing to start ({lane}): {message}")
    logger.error("consent_audit_signing.unsigned environment=%s %s", lane, message)

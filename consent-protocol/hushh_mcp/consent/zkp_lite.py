"""
Zero-Knowledge Membership Proof & Verification (ZK-Lite).

ZK-Lite Proof Engine by Abdul Gaffar — Beast Mode initiative.

Implements a non-interactive, HMAC-based commitment scheme that lets a user
prove they satisfy a policy predicate (e.g., "age >= 18") without disclosing
the underlying sensitive value (e.g., birthdate) to the consent-protocol.

How it works (ZK-Lite, not full ZK proofs)
-------------------------------------------
This is a *commitment* scheme rather than a cryptographic ZK proof.  It
provides the same privacy property for discrete attribute predicates:

1. **Commitment issuance** (by a trusted issuer, e.g. Hushh KYC service)
   The issuer verifies the raw value offline, then produces:

       nonce            = os.urandom(32)          # blinding factor
       commitment_hash  = HMAC-SHA256(
           key = signing_key,
           msg = "{user_id}:{predicate}:sat:{nonce_hex}"
       )

   The sentinel ``":sat:"`` encodes predicate satisfaction without
   embedding the raw value itself.  The commitment binds:
   - *who* the proof is for (user_id)
   - *what* they proved (predicate name)
   - *that* they satisfied it ("sat")
   - a blinding nonce so the commitment cannot be replayed for a different
     predicate or forged without the signing key

2. **Proof token** (constructed by user from the commitment)

       proof_token = f"{commitment_hash}:{nonce_hex}"

   The protocol receives only ``proof_token``; it never sees the raw age,
   birthdate, or any sensitive attribute.

3. **Verification** (by the consent-protocol)

       expected_hash = HMAC-SHA256(
           key = signing_key,
           msg = "{user_id}:{predicate}:sat:{nonce_hex}"
       )
       valid = hmac.compare_digest(commitment_hash, expected_hash)

   Constant-time comparison prevents timing attacks.

Policy integration
------------------
``build_zkp_context()`` converts a dict of ``{predicate: proof_token}`` into
a boolean context dict ``{predicate: True|False}`` that drops directly into
``PolicyEngine.build_context()`` — a ZK-verified field replaces the raw value
without the protocol ever accessing that value.

Example (Age Gate)
------------------
::

    # --- KYC service (sees birthdate; protocol does NOT) ---
    commitment = issue_zkp_commitment(
        user_id="alice",
        predicate=ZkPredicateType.AGE_GATE,
        signing_key=APP_SIGNING_KEY.encode(),
    )

    # --- User presents proof token to protocol ---
    proof_token = build_proof_token(commitment)

    # --- Protocol verifies without seeing birthdate ---
    result = verify_zkp_membership(
        proof_token=proof_token,
        user_id="alice",
        predicate=ZkPredicateType.AGE_GATE,
        signing_key=APP_SIGNING_KEY.encode(),
    )
    assert result.valid  # "alice is over 18" confirmed — birthdate never seen
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)

_LABEL = "ZK-Lite Proof Engine by Abdul Gaffar"

# Separator used in proof_token — hex chars contain only [0-9a-f] so ":" is safe
_SEP = ":"


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class ZkPredicateType(str, Enum):
    """
    Discrete attribute predicates that can be proven via ZK-lite commitment.

    Each value is a stable string key used in HMAC message construction and
    in the PolicyEngine context dict.
    """

    AGE_GATE = "age_gate"                  # user satisfies minimum age requirement
    JURISDICTION = "jurisdiction"           # user is in an allowed jurisdiction
    VERIFIED_IDENTITY = "verified_identity" # user has a verified identity credential
    CONSENT_SCOPE = "consent_scope"         # user has granted a specific scope


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ZkVerificationError(ValueError):
    """Raised when a proof token is malformed, tampered, or cannot be parsed."""


# ---------------------------------------------------------------------------
# Domain types
# ---------------------------------------------------------------------------


@dataclass
class ZkCommitment:
    """
    A ZK-lite commitment produced by the trusted issuer.

    The commitment_hash encodes {user_id}:{predicate}:sat:{nonce_hex} under
    the signing key.  The raw sensitive value is never stored here.
    """

    user_id: str
    predicate: ZkPredicateType
    committed_at: int        # Unix epoch milliseconds
    commitment_hash: str     # 64-char hex HMAC-SHA256 digest
    nonce: str               # 64-char hex random blinding factor (32 bytes)


@dataclass
class ZkVerificationResult:
    """Outcome of a ZK membership proof verification."""

    valid: bool
    predicate: ZkPredicateType
    user_id: str
    reason: str
    engine: str = _LABEL

    def summary(self) -> str:
        return (
            f"[{self.engine}] user={self.user_id} "
            f"predicate={self.predicate.value} valid={self.valid} reason={self.reason!r}"
        )


# ---------------------------------------------------------------------------
# Core commitment functions
# ---------------------------------------------------------------------------


def _compute_commitment(
    user_id: str,
    predicate: ZkPredicateType,
    nonce: str,
    signing_key: bytes,
) -> str:
    """Compute the HMAC-SHA256 commitment hash for a given input tuple."""
    msg = f"{user_id}{_SEP}{predicate.value}{_SEP}sat{_SEP}{nonce}"
    return hmac.new(signing_key, msg.encode(), hashlib.sha256).hexdigest()


def issue_zkp_commitment(
    user_id: str,
    predicate: ZkPredicateType,
    signing_key: bytes,
) -> ZkCommitment:
    """
    Issue a ZK-lite commitment for a user satisfying ``predicate``.

    Called by the trusted issuer (e.g. Hushh KYC service) after verifying
    the raw attribute value offline.  The raw value is never passed to this
    function — only the fact that the predicate is satisfied.

    Parameters
    ----------
    user_id : str
        The Firebase UID of the user being attested for.
    predicate : ZkPredicateType
        The policy predicate the issuer has verified as satisfied.
    signing_key : bytes
        The server's HMAC key.  Pass ``APP_SIGNING_KEY.encode()`` from
        ``hushh_mcp.config`` in production.

    Returns
    -------
    ZkCommitment
        Contains the commitment_hash and nonce.  Pass to ``build_proof_token``
        to obtain the string the user presents to the protocol.
    """
    nonce = os.urandom(32).hex()
    commitment_hash = _compute_commitment(user_id, predicate, nonce, signing_key)
    return ZkCommitment(
        user_id=user_id,
        predicate=predicate,
        committed_at=int(time.time() * 1000),
        commitment_hash=commitment_hash,
        nonce=nonce,
    )


def build_proof_token(commitment: ZkCommitment) -> str:
    """
    Encode a ZkCommitment as a compact proof token string.

    Format: ``"{commitment_hash}:{nonce_hex}"``

    The user presents this token to the consent-protocol.  Neither the raw
    sensitive value nor any information about it appears in the token.
    """
    return f"{commitment.commitment_hash}{_SEP}{commitment.nonce}"


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def verify_zkp_membership(
    proof_token: str,
    user_id: str,
    predicate: ZkPredicateType,
    signing_key: bytes,
) -> ZkVerificationResult:
    """
    Verify a ZK-lite membership proof without accessing the underlying value.

    Parameters
    ----------
    proof_token : str
        The ``"{commitment_hash}:{nonce}"`` string presented by the user.
    user_id : str
        Firebase UID of the user claiming the proof.
    predicate : ZkPredicateType
        The predicate the user claims to satisfy.
    signing_key : bytes
        The server's HMAC key for commitment verification.

    Returns
    -------
    ZkVerificationResult
        ``.valid`` is True iff the proof token was issued for this exact
        (user_id, predicate) pair using the same signing key.

    Raises
    ------
    ZkVerificationError
        If the proof token format is malformed (not a parse or crypto failure
        — those are returned as ``valid=False``).
    """
    try:
        if not proof_token or _SEP not in proof_token:
            raise ZkVerificationError("Proof token missing separator")
        commitment_hash, nonce = proof_token.split(_SEP, 1)
        if len(commitment_hash) != 64:
            raise ZkVerificationError(
                f"Commitment hash must be 64 hex chars, got {len(commitment_hash)}"
            )
        if not nonce:
            raise ZkVerificationError("Proof token nonce is empty")
    except ZkVerificationError:
        raise
    except Exception as exc:
        raise ZkVerificationError(f"Proof token parse error: {exc}") from exc

    expected = _compute_commitment(user_id, predicate, nonce, signing_key)
    valid = hmac.compare_digest(commitment_hash, expected)

    result = ZkVerificationResult(
        valid=valid,
        predicate=predicate,
        user_id=user_id,
        reason="commitment verified" if valid else "commitment mismatch — tampered or wrong key",
    )
    logger.info("[%s] %s", _LABEL, result.summary())
    return result


# ---------------------------------------------------------------------------
# Policy integration
# ---------------------------------------------------------------------------


def build_zkp_context(
    proofs: dict[str, str],
    user_id: str,
    signing_key: bytes,
) -> dict[str, Any]:
    """
    Convert ``{predicate_name: proof_token}`` into a boolean context dict.

    The returned dict maps each predicate name to ``True`` (proof valid) or
    ``False`` (invalid, malformed, or unknown predicate).  Drop this directly
    into ``PolicyEngine.build_context()`` to replace raw sensitive values
    with ZK-verified booleans.

    Example::

        context = build_zkp_context(
            proofs={"age_gate": user_proof_token},
            user_id="alice",
            signing_key=APP_SIGNING_KEY.encode(),
        )
        # context == {"age_gate": True}
        # PolicyEngine evaluates "age_gate == True" without seeing birthdate
    """
    context: dict[str, Any] = {}
    for predicate_name, proof_token in proofs.items():
        try:
            predicate = ZkPredicateType(predicate_name)
            result = verify_zkp_membership(proof_token, user_id, predicate, signing_key)
            context[predicate_name] = result.valid
        except (ValueError, ZkVerificationError):
            context[predicate_name] = False
    return context


# ---------------------------------------------------------------------------
# Verifier class (stateless wrapper)
# ---------------------------------------------------------------------------


class ZkMembershipVerifier:
    """
    Stateless ZK-lite membership verifier.

    ZK-Lite Proof Engine by Abdul Gaffar — wraps the module-level functions
    as an injectable service, consistent with the engine singleton pattern
    used across the consent-protocol.
    """

    def verify(
        self,
        proof_token: str,
        user_id: str,
        predicate: ZkPredicateType,
        signing_key: bytes,
    ) -> ZkVerificationResult:
        """Verify a membership proof — delegates to ``verify_zkp_membership``."""
        return verify_zkp_membership(proof_token, user_id, predicate, signing_key)

    def build_context(
        self,
        proofs: dict[str, str],
        user_id: str,
        signing_key: bytes,
    ) -> dict[str, Any]:
        """Build a boolean policy context — delegates to ``build_zkp_context``."""
        return build_zkp_context(proofs, user_id, signing_key)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

zkp_verifier = ZkMembershipVerifier()

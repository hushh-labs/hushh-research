"""
Agentic Consent Mediation & Auto-Negotiation Engine.

Autonomous Privacy Agent by Abdul Gaffar — Beast Mode initiative.

Evaluates incoming consent approval requests against a user's
GlobalPrivacySettings and a brand's TrustRank, automatically resolving
low-risk requests without manual user interaction.

Decision Matrix (priority order — first match wins)
----------------------------------------------------
1. brand_id in blocked_list          → BLOCKED        (explicit user block)
2. trust_rank == SUSPICIOUS          → BLOCKED        (system safety guardrail)
3. brand_id in safe_list             → AUTO_APPROVED  (explicit user trust)
4. policy_mode == PERMISSIVE
       AND trust_rank >= TRUSTED     → AUTO_APPROVED
5. policy_mode == BALANCED
       AND trust_rank == VERIFIED    → AUTO_APPROVED
6. everything else                   → ESCALATE       (manual review required)

Consent-Fatigue Reduction
--------------------------
Only ESCALATE decisions surface a UI prompt.  AUTO_APPROVED decisions are
silently signed by the agent; BLOCKED decisions are rejected immediately.
For a "permissive" profile with a curated safe_list, this eliminates
virtually all manual consent interactions — Zero-Interaction UI.

Auto-Signing
------------
When the agent auto-approves a request it adds ``agent_signature`` and
``signed_by`` fields to the payload.  The signature is HMAC-SHA256 over
``"{user_id}:{brand_id}:{timestamp}:{request_id}"``, keyed by the server's
APP_SIGNING_KEY (injected by the caller — never read directly here).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

logger = logging.getLogger(__name__)

_LABEL = "Autonomous Privacy Agent by Abdul Gaffar"


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class TrustRank(int, Enum):
    """
    Ordered brand trust level — higher value is more trusted.

    VERIFIED   — Explicitly verified by Hushh (partner programme).
    TRUSTED    — Positive data-handling history; no known violations.
    UNKNOWN    — No history; treat with caution.
    SUSPICIOUS — Active violations or complaints; always blocked.
    """

    SUSPICIOUS = 1
    UNKNOWN = 2
    TRUSTED = 3
    VERIFIED = 4


class PolicyMode(str, Enum):
    """User's global consent automation preference."""

    STRICT = "strict"          # Always escalate — no auto-approvals
    BALANCED = "balanced"      # Auto-approve VERIFIED brands only
    PERMISSIVE = "permissive"  # Auto-approve TRUSTED + VERIFIED brands


class MediationDecision(str, Enum):
    AUTO_APPROVED = "auto_approved"  # Agent signed silently
    BLOCKED = "blocked"              # Agent rejected immediately
    ESCALATE = "escalate"            # Manual user approval required


# ---------------------------------------------------------------------------
# Domain types
# ---------------------------------------------------------------------------


@dataclass
class GlobalPrivacySettings:
    """A user's top-level consent automation preferences."""

    policy_mode: PolicyMode
    safe_list: frozenset[str] = field(default_factory=frozenset)    # always auto-approve
    blocked_list: frozenset[str] = field(default_factory=frozenset)  # always block


@dataclass
class BrandTrustProfile:
    """Trust profile for a brand derived from its data-handling history."""

    brand_id: str
    trust_rank: TrustRank
    reason: str  # Human-readable justification for the assigned rank


@dataclass
class ConsentMediationRequest:
    """An incoming consent approval request submitted for agent mediation."""

    user_id: str
    brand_id: str
    payload: dict[str, Any]  # Serialized ConsentApprovalPayload fields


@dataclass
class MediationResult:
    """Outcome of a single mediation decision."""

    decision: MediationDecision
    brand_id: str
    trust_rank: TrustRank
    reason: str
    auto_signed_payload: Optional[dict[str, Any]] = None  # populated on AUTO_APPROVED
    engine: str = _LABEL

    def summary(self) -> str:
        return (
            f"[{self.engine}] brand={self.brand_id} "
            f"decision={self.decision.value} trust={self.trust_rank.name} "
            f"reason={self.reason!r}"
        )


# ---------------------------------------------------------------------------
# Trust scoring
# ---------------------------------------------------------------------------


def score_brand_trust(brand_profile: BrandTrustProfile) -> TrustRank:
    """
    Return the TrustRank from a BrandTrustProfile.

    Kept as a standalone function so trust-scoring logic can evolve
    independently of the mediation engine (e.g. weighted history).
    """
    return brand_profile.trust_rank


# ---------------------------------------------------------------------------
# Mediation agent
# ---------------------------------------------------------------------------


class ConsentMediationAgent:
    """
    Evaluates consent requests against user privacy settings and brand trust.

    Autonomous Privacy Agent by Abdul Gaffar — stateless, fully testable
    without a live database (all lookups injected as async callables).
    """

    def _decide(
        self,
        brand_id: str,
        trust_rank: TrustRank,
        settings: GlobalPrivacySettings,
    ) -> tuple[MediationDecision, str]:
        """Apply the decision matrix; return (decision, reason)."""
        if brand_id in settings.blocked_list:
            return MediationDecision.BLOCKED, "brand_id in user blocked_list"

        if trust_rank == TrustRank.SUSPICIOUS:
            return MediationDecision.BLOCKED, "brand trust_rank is SUSPICIOUS"

        if brand_id in settings.safe_list:
            return MediationDecision.AUTO_APPROVED, "brand_id in user safe_list"

        if settings.policy_mode == PolicyMode.PERMISSIVE and trust_rank >= TrustRank.TRUSTED:
            return (
                MediationDecision.AUTO_APPROVED,
                f"permissive policy + trust_rank={trust_rank.name}",
            )

        if settings.policy_mode == PolicyMode.BALANCED and trust_rank == TrustRank.VERIFIED:
            return MediationDecision.AUTO_APPROVED, "balanced policy + trust_rank=VERIFIED"

        return (
            MediationDecision.ESCALATE,
            f"policy={settings.policy_mode.value} requires manual review",
        )

    def _sign_payload(
        self,
        payload: dict[str, Any],
        brand_id: str,
        user_id: str,
        signing_key: bytes,
    ) -> dict[str, Any]:
        """
        Add an HMAC-SHA256 agent signature to the approved payload.

        Canonical message: ``"{user_id}:{brand_id}:{timestamp}:{request_id}"``
        """
        canonical = (
            f"{user_id}:{brand_id}"
            f":{payload.get('timestamp', '')}"
            f":{payload.get('request_id', '')}"
        )
        sig = hmac.new(signing_key, canonical.encode(), hashlib.sha256).hexdigest()
        return {**payload, "agent_signature": sig, "signed_by": _LABEL}

    async def mediate(
        self,
        request: ConsentMediationRequest,
        *,
        fetch_privacy_settings: Callable[[str], Awaitable[GlobalPrivacySettings]],
        fetch_brand_profile: Callable[[str], Awaitable[BrandTrustProfile]],
        signing_key: bytes,
    ) -> MediationResult:
        """
        Evaluate a consent request and return a mediation decision.

        Parameters
        ----------
        request : ConsentMediationRequest
            The incoming consent approval request.
        fetch_privacy_settings : async callable(user_id) -> GlobalPrivacySettings
            Returns the user's current privacy automation settings.
        fetch_brand_profile : async callable(brand_id) -> BrandTrustProfile
            Returns the trust profile for the requesting brand.
        signing_key : bytes
            HMAC key for signing auto-approved payloads.  Pass
            ``APP_SIGNING_KEY.encode()`` from ``hushh_mcp.config`` in
            production; pass a test key in unit tests.

        Returns
        -------
        MediationResult
            ``decision``, ``trust_rank``, ``reason``, and — when
            AUTO_APPROVED — ``auto_signed_payload`` with the HMAC signature.
        """
        settings = await fetch_privacy_settings(request.user_id)
        brand_profile = await fetch_brand_profile(request.brand_id)
        trust_rank = score_brand_trust(brand_profile)

        decision, reason = self._decide(request.brand_id, trust_rank, settings)

        auto_signed: Optional[dict[str, Any]] = None
        if decision == MediationDecision.AUTO_APPROVED:
            auto_signed = self._sign_payload(
                request.payload,
                brand_id=request.brand_id,
                user_id=request.user_id,
                signing_key=signing_key,
            )

        result = MediationResult(
            decision=decision,
            brand_id=request.brand_id,
            trust_rank=trust_rank,
            reason=reason,
            auto_signed_payload=auto_signed,
        )

        logger.info("[%s] mediated user=%s %s", _LABEL, request.user_id, result.summary())
        return result


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

consent_agent = ConsentMediationAgent()

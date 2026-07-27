"""Provision and tear down a user's own personal-information agent.

This is the orchestration that stands a user's agent up on join and removes it
cleanly on leave. It composes the pieces already built, and stays inert behind
the ``PERSONAL_AGENT_ENABLED`` kill-switch:

  provision:
    1. derive the opaque HusshID and the stored phone hash from the verified
       phone (``personal_agent_identity_service``);
    2. validate the pod's own X25519 PUBLIC key (``pod_connector_keypair_service``)
       — Hushh only ever stores the public half, never the private key;
    3. record the mapping (HusshID, phone hash, pod public key) in the registry as
       ``provisioning`` — BEFORE any token exists, so a registry failure can never
       orphan a live standing grant;
    4. mint the standing, Nav-governed pkm.read for the user's own agent
       (``personal_agent_grant_service``);
    5. flip the registry row to ``provisioned`` once the read authority is live.

  deprovision (mirrors the account-deletion teardown seam):
    1. revoke the standing pkm.read FIRST (a REVOKED consent event), so the pod's
       read authority is dead immediately rather than at its 24h expiry;
    2. write a retained tombstone so the teardown stays auditable after the
       user's rows are gone;
    3. delete the registry row.
    Revocation needs no stored token copy -- it writes a REVOKED marker for
    (user, pkm.read, personal_agent) and is_token_active keys off the latest
    event. The account-deletion cascade independently fail-closes the token too.

The registry is injected (a small Protocol), so the whole flow is testable with
no DB. The concrete DB-backed registry adapter (``personal_agent_registry_repo``)
and the owner-authorized route (``api/routes/one/personal_agent.py``) are wired
but flag-gated: the route returns 404 and this module does no work until
``PERSONAL_AGENT_ENABLED`` is on.
"""

from __future__ import annotations

import logging
from typing import Any, Optional, Protocol

from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.compute_backend import (
    BackendHandle,
    ComputeBackend,
    NullBackend,
    PodSpec,
)
from hushh_mcp.services.personal_agent_grant_service import (
    PersonalAgentDisabledError,
    PersonalAgentGrantService,
)
from hushh_mcp.services.personal_agent_identity_service import (
    hash_phone_e164,
    mint_hushh_id,
)
from hushh_mcp.services.pod_connector_keypair_service import (
    WRAPPING_ALG,
    parse_pod_public_key,
)

logger = logging.getLogger(__name__)

# Upper bound on recycled-phone generation probing. A single number would have to
# be tombstoned thousands of times to approach this; the cap only prevents an
# unbounded loop on a pathological/corrupt tombstone table.
_MAX_HUSHH_ID_GENERATIONS = 4096


class _Registry(Protocol):
    async def upsert(
        self,
        *,
        user_id: str,
        hushh_id: str,
        phone_e164_hash: str,
        status: str,
        pod_pubkey: Optional[str] = ...,
        pod_key_id: Optional[str] = ...,
        pod_key_wrapping_alg: Optional[str] = ...,
        external_agent_id: Optional[str] = ...,
        a2a_route: Optional[str] = ...,
        backend: Optional[str] = ...,
        space_id: Optional[str] = ...,
        backend_metadata: Optional[dict] = ...,
        attestation_ref: Optional[str] = ...,
    ) -> None: ...

    async def get(self, user_id: str) -> Optional[dict]: ...

    async def tombstone(
        self, *, hushh_id: Optional[str], external_agent_id: Optional[str], status: str
    ) -> None: ...

    async def delete(self, user_id: str) -> None: ...

    async def tombstone_exists(self, hushh_id: str) -> bool: ...


class _Grant(Protocol):
    async def issue_standing_pkm_read(
        self, user_id: str, *, ledger: Any = ...
    ) -> dict[str, Any]: ...

    async def revoke_standing_pkm_read(
        self, user_id: str, *, ledger: Any = ...
    ) -> dict[str, Any]: ...


class PersonalAgentProvisioningService:
    """Orchestrates provisioning and teardown of a user's own agent."""

    def __init__(
        self,
        *,
        registry: _Registry,
        grant: Optional[_Grant] = None,
        backend: Optional[ComputeBackend] = None,
    ) -> None:
        self._registry = registry
        self._grant: _Grant = grant or PersonalAgentGrantService()
        # Compute host provider (the provider abstraction, ARCHITECTURE.md §5).
        # NullBackend by default, so Phase 0 stays a pure registry stamp with no
        # host call. M4/M7 thread host create through provision(); deprovision()
        # already routes teardown through it (guarded on a populated
        # external_agent_id, which is always NULL until a real backend provisions).
        self._backend: ComputeBackend = backend or NullBackend()

    async def provision(
        self,
        *,
        user_id: str,
        phone_e164: str,
        pod_public_key_b64: str,
        pod_key_id: str,
        pod_key_wrapping_alg: str = WRAPPING_ALG,
        ledger: Any = None,
    ) -> dict[str, Any]:
        """Stand up the user's agent. Owner authorization is the caller's job.

        Idempotent by user (``upsert``). Raises ``PersonalAgentDisabledError``
        when off, and ``ValueError`` on a bad phone or pod key.

        Ordering (SECURITY-REVIEW.md M3): derive + validate first (no side effect),
        then record the registry row as ``provisioning``, then mint the standing
        read, then flip the row to ``provisioned``. Recording BEFORE minting means
        a registry failure can never orphan a live standing grant, and a mint that
        never completes leaves the row visibly stuck in ``provisioning`` for a
        reconcile sweep. Re-provision is safe: a new grant supersedes any prior one
        (``is_token_active`` is latest-wins + token_id-matched), so live standing
        tokens cannot accumulate.
        """
        if not personal_agent_enabled():
            raise PersonalAgentDisabledError(
                "provisioning requested while PERSONAL_AGENT_ENABLED is off"
            )
        if not user_id:
            raise ValueError("user_id is required")

        # Recycled-phone rotation (SECURITY-REVIEW.md L1): a reassigned phone must
        # not re-derive a prior owner's HusshID. Pick the first generation whose
        # HusshID has no deletion tombstone. A fresh phone lands on generation 0.
        generation = await self._next_free_generation(phone_e164)
        hushh_id = mint_hushh_id(phone_e164, generation)
        phone_hash = hash_phone_e164(phone_e164)
        pod_key = parse_pod_public_key(pod_public_key_b64, pod_key_id, pod_key_wrapping_alg)

        async def _record(status: str, handle: Optional[BackendHandle] = None) -> None:
            fields: dict[str, Any] = dict(
                user_id=user_id,
                hushh_id=hushh_id,
                phone_e164_hash=phone_hash,
                pod_pubkey=pod_key.public_key_b64,
                pod_key_id=pod_key.key_id,
                pod_key_wrapping_alg=pod_key.wrapping_alg,
                status=status,
            )
            if handle is not None:
                # None handle fields are dropped by the repo, so NullBackend (all-None)
                # leaves the row's host columns at their schema NULLs -- behavior
                # identical to the pre-threading Phase-0 stamp.
                fields.update(
                    external_agent_id=handle.external_agent_id,
                    a2a_route=handle.a2a_route,
                    backend=handle.backend,
                    backend_metadata=handle.backend_metadata,
                    attestation_ref=handle.attestation_ref,
                )
            await self._registry.upsert(**fields)

        # Record the mapping BEFORE any host or token side effect: a registry failure
        # can never orphan a live host or a live standing grant (SECURITY-REVIEW.md M3).
        await _record("provisioning")
        # Stand the host up on the selected compute backend. Inert for NullBackend
        # (default) and for the gcp/anypoint adapters in plan mode; a real host only
        # materializes when a backend is enabled live. Done BEFORE the mint so a host
        # failure leaves the row visibly stuck in ``provisioning`` for reconcile,
        # never a live grant with no host.
        spec = PodSpec(
            hushh_id=hushh_id,
            phone_e164_hash=phone_hash,
            pod_pubkey=pod_key.public_key_b64,
        )
        handle = await self._backend.provision(spec)
        await _record("provisioning", handle=handle)
        # Mint only after the row + host exist.
        grant = await self._grant.issue_standing_pkm_read(user_id, ledger=ledger)
        # Flip to provisioned now that the read authority is live.
        await _record("provisioned", handle=handle)

        logger.info(
            "personal_agent.provisioned hushh_id_present=%s backend=%s",
            bool(hushh_id),
            handle.backend or "null",
        )
        return {
            "hushhId": hushh_id,
            "status": "provisioned",
            "backend": handle.backend,
            "externalAgentId": handle.external_agent_id,
            "a2aRoute": handle.a2a_route,
            "standingReadExpiresAt": grant.get("expiresAt"),
        }

    async def register_pending(self, *, user_id: str, phone_e164: str) -> dict[str, Any]:
        """Phone-verify seam: assign the sovereign HusshID and record a PENDING row.

        On phone verification the user becomes addressable -- their HusshID is
        minted (with recycled-phone rotation) and a ``pending`` registry row is
        recorded -- but there is no pod key or standing read yet: those arrive when
        the pod materializes and the owner-authorized ``/provision`` completes.

        Idempotent and non-destructive: if a row already exists (pending OR a fully
        provisioned agent), it is returned unchanged -- a re-fired phone-verify
        never downgrades a provisioned agent back to pending. Flag-gated.
        """
        if not personal_agent_enabled():
            raise PersonalAgentDisabledError(
                "register_pending requested while PERSONAL_AGENT_ENABLED is off"
            )
        if not user_id:
            raise ValueError("user_id is required")

        existing = await self._registry.get(user_id)
        if existing is not None:
            return {"hushhId": existing.get("hushh_id"), "status": existing.get("status")}

        generation = await self._next_free_generation(phone_e164)
        hushh_id = mint_hushh_id(phone_e164, generation)
        phone_hash = hash_phone_e164(phone_e164)
        await self._registry.upsert(
            user_id=user_id,
            hushh_id=hushh_id,
            phone_e164_hash=phone_hash,
            status="pending",
        )
        logger.info("personal_agent.registered_pending hushh_id_present=%s", bool(hushh_id))
        return {"hushhId": hushh_id, "status": "pending"}

    async def deprovision(
        self, *, user_id: str, ledger: Any = None, revoke: bool = True
    ) -> dict[str, Any]:
        """Tear down the user's agent: revoke the standing read, tombstone, delete.

        Best-effort and idempotent: a missing row still writes a tombstone and a
        (no-op) delete, so teardown stays auditable and safe to retry.

        The standing pkm.read is revoked FIRST so the pod's read authority is dead
        immediately, not at its 24h expiry (SECURITY-REVIEW.md M2). Revocation is
        best-effort: a failure is logged and surfaced in ``standingReadRevoked``
        but never blocks teardown.

        ``revoke=False`` is for the account-deletion path, where the deletion
        cascade has ALREADY wiped this user's consent_audit rows (which
        independently fail-closes the token). Writing a REVOKED event there would
        re-create a consent_audit row for a just-deleted user and break the erasure
        guarantee, so the caller suppresses it.
        """
        if not user_id:
            raise ValueError("user_id is required")

        revoked = False
        if revoke:
            try:
                await self._grant.revoke_standing_pkm_read(user_id, ledger=ledger)
                revoked = True
            except Exception as exc:  # best-effort: teardown must still complete
                logger.warning(
                    "personal_agent.deprovision revoke_failed err=%s", type(exc).__name__
                )

        row = await self._registry.get(user_id)
        hushh_id = (row or {}).get("hushh_id")
        external_agent_id = (row or {}).get("external_agent_id")

        # Route host teardown through the selected compute backend. Inert in Phase 0:
        # external_agent_id is NULL until a real backend provisions a host, so the
        # backend is never even called here (and NullBackend is a no-op regardless).
        if external_agent_id:
            try:
                await self._backend.deprovision(external_agent_id)
            except Exception as exc:  # best-effort: teardown must still complete
                logger.warning(
                    "personal_agent.deprovision backend_teardown_failed err=%s",
                    type(exc).__name__,
                )

        await self._registry.tombstone(
            hushh_id=hushh_id,
            external_agent_id=external_agent_id,
            status="deprovision_requested",
        )
        await self._registry.delete(user_id)
        logger.info(
            "personal_agent.deprovisioned had_row=%s standing_read_revoked=%s",
            row is not None,
            revoked,
        )
        return {"status": "deprovisioned", "hushhId": hushh_id, "standingReadRevoked": revoked}

    async def _next_free_generation(self, phone_e164: str) -> int:
        """First HusshID generation for this phone that has no deletion tombstone.

        A fresh phone returns 0. A recycled phone whose prior generations are
        tombstoned rotates forward to the next untombstoned generation, so a
        reassigned number never re-derives (and thus never resurrects) a prior
        owner's HusshID or A2A address.
        """
        for generation in range(_MAX_HUSHH_ID_GENERATIONS):
            candidate = mint_hushh_id(phone_e164, generation)
            if not await self._registry.tombstone_exists(candidate):
                return generation
        raise ValueError("exhausted HusshID generations for this phone")

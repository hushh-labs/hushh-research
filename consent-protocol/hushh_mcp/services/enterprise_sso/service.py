"""Enterprise SSO: org discovery, code exchange, and Directory Sync deprovisioning.

Identity proof only. A successful exchange yields a Firebase custom token and
nothing else: no role, no consent, no vault access. Authorization stays DB-driven
and unchanged.

No table backs this. WorkOS is the authority for organizations, their DNS-verified
domains and their connections; Firebase is the authority for accounts. See
docs/reference/architecture/enterprise-sso-workos-adr.md.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections.abc import Callable
from typing import Any, Protocol

from .consumer_domains import CONSUMER_EMAIL_DOMAINS
from .errors import EnterpriseSsoError
from .firebase_identity import (
    CLAIM_DEPROVISIONED_AT,
    CLAIM_ORG,
    CLAIM_ORIGIN,
    CLAIM_USER,
    ORIGIN_CREATED,
    ORIGIN_LINKED,
    SSO_AUTH_PROVIDER,
    FirebaseAdminIdentity,
    FirebaseIdentityPort,
    FirebaseUserInfo,
    require_generation_compatibility,
)
from .workos_adapter import (
    SsoProfile,
    WorkOSConfig,
    WorkOSOrganization,
    WorkOSPort,
    WorkOSSdkAdapter,
    sign_state,
    verify_state,
    verify_webhook_signature,
)

logger = logging.getLogger(__name__)

MAX_WEBHOOK_BODY_BYTES = 256_000


class ConsentRevoker(Protocol):
    async def revoke_all_active_grants(self, user_id: str) -> int: ...


def _normalize_email(value: str | None) -> str:
    return str(value or "").strip().lower()


def _email_domain(email: str) -> str:
    local, _, domain = email.rpartition("@")
    return domain if local and domain else ""


def _profile_display_name(profile: SsoProfile) -> str | None:
    """The person's name from the IdP, held to the same rules as the name editor in the app
    (2-60 characters, no links or handles). A name is optional: one that does not pass is
    dropped and sign-in carries on without it."""
    raw = " ".join(part for part in (profile.first_name, profile.last_name) if part) or profile.name
    if not raw:
        return None
    # Imported here because that service pulls in the database layer, which this module must not.
    from hushh_mcp.services.actor_identity_service import ActorIdentityService

    try:
        return ActorIdentityService.validate_display_name(raw)
    except ValueError:
        return None


def sso_uid(workos_org_id: str, workos_user_id: str) -> str:
    """The Firebase UID for a person this feature creates an account for.

    Deterministic, so two simultaneous first sign-ins cannot make two accounts and a
    changed work email cannot make a second one. Deliberately unkeyed: it must never
    depend on a secret that gets rotated, because rotating it would move everyone to
    new, empty accounts. A UID is an identifier, not a credential; signing in still
    needs a token that only this service can mint.
    """
    digest = hashlib.sha256(
        f"hussh.enterprise-sso.uid.v1\0{workos_org_id}\0{workos_user_id}".encode()
    ).hexdigest()
    return f"sso_{digest[:32]}"


def _tombstoned(uid: str) -> bool:
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionInProgressError,
        AccountDeletionLifecycleService,
    )

    try:
        return AccountDeletionLifecycleService.is_tombstoned(uid)
    except AccountDeletionInProgressError:
        raise EnterpriseSsoError("sso_unavailable", 503) from None


class EnterpriseSsoService:
    def __init__(
        self,
        *,
        workos: WorkOSPort | None = None,
        config: WorkOSConfig | None = None,
        firebase: FirebaseIdentityPort | None = None,
        consent: ConsentRevoker | None = None,
        is_tombstoned: Callable[[str], bool] | None = None,
    ) -> None:
        self._config = config or WorkOSConfig.from_env()
        self._workos = workos or WorkOSSdkAdapter(self._config)
        self._firebase = firebase or FirebaseAdminIdentity()
        self._consent = consent
        self._is_tombstoned = is_tombstoned or _tombstoned

    def _consent_service(self) -> ConsentRevoker:
        if self._consent is None:
            from hushh_mcp.services.consent_lifecycle_service import ConsentLifecycleService

            self._consent = ConsentLifecycleService()
        return self._consent

    def _require_sign_in_ready(self) -> None:
        require_generation_compatibility()
        if not self._config.sign_in_ready:
            raise EnterpriseSsoError("sso_unavailable", 503)

    # ── GET /start ──

    async def start(
        self, *, email: str | None, organization_id: str | None, origin: str | None = None
    ) -> dict[str, Any]:
        self._require_sign_in_ready()
        normalized = _normalize_email(email)
        domain = _email_domain(normalized)
        org: WorkOSOrganization | None
        if organization_id:
            org = await asyncio.to_thread(self._workos.get_organization, organization_id.strip())
        elif domain and domain not in CONSUMER_EMAIL_DOMAINS:
            # WorkOS decides who owns a domain: only a DNS-verified one, and not one whose SSO is switched off.
            org = await asyncio.to_thread(self._workos.find_organization_by_domain, domain)
        else:
            org = None
        # Switching every connection off in WorkOS is the off switch for an organization.
        if not org or org.sso_disabled:
            raise EnterpriseSsoError("sso_not_available", 404)
        state = sign_state(self._config.api_key, org.id)
        url = await asyncio.to_thread(
            self._workos.authorization_url,
            organization_id=org.id,
            state=state,
            login_hint=normalized or None,
            redirect_uri=self._config.redirect_uri_for(origin),
        )
        return {"authorization_url": url, "state": state, "organization": {"name": org.name}}

    # ── POST /exchange ──

    async def exchange(self, *, code: str, state: str) -> dict[str, Any]:
        self._require_sign_in_ready()
        expected_org = verify_state(self._config.api_key, state)
        profile = await asyncio.to_thread(self._workos.exchange_code, code)
        # WorkOS: validate the profile's organization; never infer it from the email domain.
        if not profile.organization_id or profile.organization_id != expected_org:
            raise EnterpriseSsoError("sso_org_mismatch", 403)
        org = await asyncio.to_thread(self._workos.get_organization, profile.organization_id)
        if not org or org.sso_disabled:
            raise EnterpriseSsoError("sso_org_not_enabled", 403)

        # The email's domain must be one this org has verified with WorkOS by DNS. An
        # org's IdP can therefore only assert addresses its company actually owns.
        email = _normalize_email(profile.email)
        domain = _email_domain(email)
        if not domain or domain in CONSUMER_EMAIL_DOMAINS or domain not in org.verified_domains:
            raise EnterpriseSsoError("sso_domain_not_verified", 403)

        uid, is_new = await self._resolve_account(
            org_id=org.id,
            workos_user_id=profile.id,
            email=email,
            display_name=_profile_display_name(profile),
        )
        token = await self._firebase.mint_token(
            uid, {"auth_provider": SSO_AUTH_PROVIDER, "workos_org_id": org.id}
        )
        return {
            "custom_token": token,
            "user_id": uid,
            "is_new_account": is_new,
            "organization": {"name": org.name},
        }

    async def _resolve_account(
        self, *, org_id: str, workos_user_id: str, email: str, display_name: str | None = None
    ) -> tuple[str, bool]:
        mine = sso_uid(org_id, workos_user_id)
        user = await self._firebase.get_user(mine)
        if user:
            self._assert_signable(user, org_id=org_id, workos_user_id=workos_user_id)
            await self._ensure_claims(user, org_id, workos_user_id, ORIGIN_CREATED)
            await self._fill_display_name(user, display_name)
            return user.uid, False

        # First sign-in. Link an existing Hussh account only when its email is verified
        # (an unverified one could be a pre-registered squat of this address).
        existing = await self._firebase.find_by_email(email)
        if existing:
            if not existing.email_verified:
                raise EnterpriseSsoError("sso_email_conflict", 409)
            self._assert_signable(existing, org_id=org_id, workos_user_id=workos_user_id)
            await self._ensure_claims(existing, org_id, workos_user_id, ORIGIN_LINKED)
            await self._fill_display_name(existing, display_name)
            return existing.uid, False

        # Never recreate an account the person deleted: its tombstone would reject it anyway.
        if await asyncio.to_thread(self._is_tombstoned, mine):
            raise EnterpriseSsoError("sso_account_deleted", 403)
        await self._firebase.create_user(mine, email, display_name)
        await self._firebase.merge_claims(
            mine,
            {CLAIM_ORG: org_id, CLAIM_USER: workos_user_id, CLAIM_ORIGIN: ORIGIN_CREATED},
        )
        return mine, True

    async def _fill_display_name(self, user: FirebaseUserInfo, display_name: str | None) -> None:
        """Give an account the IdP's name only when it has none. A name the person chose, or one a
        Google or Apple sign-in already gave the account, is never replaced. The name is cosmetic,
        so failing to save it must not stop the person signing in."""
        if not display_name or user.display_name:
            return
        try:
            await self._firebase.set_display_name(user.uid, display_name)
        except Exception as exc:  # noqa: BLE001 - provider SDK errors are opaque; the name is optional
            logger.warning("enterprise_sso.display_name_not_set error=%s", type(exc).__name__)

    @staticmethod
    def _assert_signable(user: FirebaseUserInfo, *, org_id: str, workos_user_id: str) -> None:
        claims = user.claims
        if user.disabled or claims.get(CLAIM_DEPROVISIONED_AT):
            raise EnterpriseSsoError("sso_deprovisioned", 403)
        # One WorkOS person per account, in one org: never hand an account to a different
        # person who happens to share its address (a new hire reusing a leaver's email).
        if claims.get(CLAIM_ORG, org_id) != org_id or claims.get(CLAIM_USER, workos_user_id) != (
            workos_user_id
        ):
            raise EnterpriseSsoError("sso_account_conflict", 409)

    async def _ensure_claims(
        self, user: FirebaseUserInfo, org_id: str, workos_user_id: str, origin: str
    ) -> None:
        if user.claims.get(CLAIM_ORG) == org_id and user.claims.get(CLAIM_USER) == workos_user_id:
            return
        await self._firebase.merge_claims(
            user.uid, {CLAIM_ORG: org_id, CLAIM_USER: workos_user_id, CLAIM_ORIGIN: origin}
        )

    # ── POST /webhooks/workos ──

    async def handle_webhook(self, *, body: bytes, signature: str | None) -> dict[str, Any]:
        require_generation_compatibility()
        if not self._config.webhook_secret:
            raise EnterpriseSsoError("sso_unavailable", 503)
        if len(body) > MAX_WEBHOOK_BODY_BYTES:
            raise EnterpriseSsoError("webhook_too_large", 413)
        verify_webhook_signature(body, signature, self._config.webhook_secret)
        try:
            event = json.loads(body)
            event_type = str(event["event"])
            data = event.get("data") or {}
            if not isinstance(data, dict):
                raise TypeError
        except (ValueError, KeyError, TypeError, AttributeError):
            raise EnterpriseSsoError("webhook_invalid_event", 400) from None

        # No dedupe ledger: every step below is idempotent, so a redelivery (WorkOS retries
        # on any non-2xx) or a replay inside the 180 s signature window repeats harmlessly.
        deprovisioned = 0
        if self._is_deprovision(event_type, data):
            deprovisioned = await self._deprovision(data)
        return {"received": True, "deprovisioned": deprovisioned}

    @staticmethod
    def _is_deprovision(event_type: str, data: dict[str, Any]) -> bool:
        if event_type == "dsync.user.deleted":
            return True
        # A directory deactivation arrives as an update to the user, not its own event.
        return event_type == "dsync.user.updated" and str(data.get("state") or "") in {
            "inactive",
            "suspended",
        }

    async def _deprovision(self, data: dict[str, Any]) -> int:
        workos_org_id = str(data.get("organization_id") or "")
        email = _normalize_email(data.get("email"))
        if not workos_org_id or not email:
            return 0
        user = await self._firebase.find_by_email(email)
        # Only someone who signed in through this organization is ours to deprovision.
        if not user or user.claims.get(CLAIM_ORG) != workos_org_id:
            return 0

        # Refuse new sign-ins first, so a failure below cannot leave the door open.
        if not user.claims.get(CLAIM_DEPROVISIONED_AT):
            await self._firebase.merge_claims(user.uid, {CLAIM_DEPROVISIONED_AT: int(time.time())})
        if user.claims.get(CLAIM_ORIGIN) == ORIGIN_CREATED:
            # SSO made this account for the person's work: end it and what it granted.
            if not await self._firebase.quarantine(user.uid):
                raise EnterpriseSsoError("deprovision_incomplete", 503)
            await self._consent_service().revoke_all_active_grants(user.uid)
        elif not await self._firebase.revoke_sessions(user.uid):
            # A personal account that was linked: end the work session, but leave the
            # person's own account, vault and grants alone. They can still sign in normally.
            raise EnterpriseSsoError("deprovision_incomplete", 503)
        logger.info("enterprise_sso.deprovisioned")
        return 1

"""The WorkOS boundary: SDK adapter, webhook signature check, signed SSO state.

Import-safe: the ``workos`` SDK loads only when a live client is first used, so
the flag-off path and unit tests never import it. Everything WorkOS-shaped stops
here; the service sees only ``SsoProfile`` and plain strings.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlparse

from .errors import EnterpriseSsoError

logger = logging.getLogger(__name__)

WEBHOOK_TOLERANCE_SECONDS = 180  # the WorkOS SDK's own default
STATE_TTL_SECONDS = 600
_STATE_KEY_LABEL = b"hussh.enterprise-sso.state.v1"
# `legacy_verified` is how WorkOS labels domains verified before the current flow.
_VERIFIED_DOMAIN_STATES = frozenset({"verified", "legacy_verified"})


@dataclass(frozen=True)
class WorkOSConfig:
    api_key: str = ""
    client_id: str = ""
    webhook_secret: str = ""
    redirect_uri: str = ""
    # Origins the person may start from (the app is served on several hostnames per environment).
    redirect_origins: tuple[str, ...] = ()

    @classmethod
    def from_env(cls) -> WorkOSConfig:
        def read(name: str) -> str:
            return str(os.getenv(name) or "").strip()

        return cls(
            api_key=read("WORKOS_API_KEY"),
            client_id=read("WORKOS_CLIENT_ID"),
            webhook_secret=read("WORKOS_WEBHOOK_SECRET"),
            redirect_uri=read("WORKOS_REDIRECT_URI"),
            redirect_origins=tuple(
                part.strip() for part in read("WORKOS_REDIRECT_ORIGINS").split(",") if part.strip()
            ),
        )

    def _allowed_origins(self) -> frozenset[str]:
        default = urlparse(self.redirect_uri)
        base = f"{default.scheme}://{default.netloc}" if default.netloc else ""
        found = (str(o).strip().rstrip("/").lower() for o in (*self.redirect_origins, base))
        return frozenset(
            o for o in found if o.startswith("https://") or o.startswith("http://localhost")
        )

    def redirect_uri_for(self, origin: str | None) -> str:
        """Send the person back to the origin they started on, but only to one we serve.

        The pending-attempt state lives in that origin's sessionStorage, so the callback has to
        return there. Anything not on the allowlist falls back to the configured default."""
        candidate = str(origin or "").strip().rstrip("/").lower()
        if candidate and candidate in self._allowed_origins():
            return f"{candidate}{urlparse(self.redirect_uri).path or '/login'}"
        return self.redirect_uri

    @property
    def sign_in_ready(self) -> bool:
        # The webhook is how offboarding reaches us, so sign-in is not offered
        # without it: SSO that cannot deprovision must not sign anyone in.
        return bool(self.api_key and self.client_id and self.redirect_uri and self.webhook_secret)


@dataclass(frozen=True)
class SsoProfile:
    """What we keep from the IdP's profile: who they are (id, email, organization) and what to call
    them. Groups, roles, raw attributes and the WorkOS access token are deliberately not read."""

    id: str
    organization_id: str | None
    email: str
    first_name: str | None = None
    last_name: str | None = None
    name: str | None = None  # a full name, for IdPs that send no first/last split
    connection_id: str | None = None
    idp_id: str | None = None


@dataclass(frozen=True)
class DirectoryMembership:
    directory_id: str
    user_id: str


@dataclass(frozen=True)
class WorkOSOrganization:
    """What WorkOS itself says about an organization. WorkOS is the authority:
    its domains are verified by DNS and its connection is the one that signs people in.

    ``sso_disabled`` is True only when WorkOS lists connections for the organization and none
    is active (for example a customer switched theirs off). An organization with no listed
    connection is NOT treated as disabled: WorkOS keeps its built-in Test Identity Provider
    out of the listing, and WorkOS itself refuses to authenticate anyone without a usable
    connection, so the listing cannot be taken as proof that there is none.
    """

    id: str
    name: str
    verified_domains: frozenset[str]
    sso_disabled: bool


class WorkOSPort(Protocol):
    def find_organization_by_domain(self, domain: str) -> WorkOSOrganization | None: ...

    def get_organization(self, organization_id: str) -> WorkOSOrganization | None: ...

    def authorization_url(
        self,
        *,
        organization_id: str,
        state: str,
        login_hint: str | None,
        redirect_uri: str | None = None,
    ) -> str: ...

    def exchange_code(self, code: str) -> SsoProfile: ...

    def directory_membership(self, profile: SsoProfile) -> DirectoryMembership | None: ...


class WorkOSSdkAdapter:
    """Live WorkOS client. The redirect URI is server configuration, never client input."""

    def __init__(self, config: WorkOSConfig) -> None:
        self._config = config
        self._client = None

    def _sdk(self):
        if self._client is None:
            from workos import WorkOSClient

            self._client = WorkOSClient(
                api_key=self._config.api_key, client_id=self._config.client_id
            )
        return self._client

    def _is_staging(self) -> bool:
        # Staging hides WorkOS's built-in test provider from the list, so an empty list proves
        # nothing there. Production has no such provider: an empty list means SSO is not set up.
        return self._config.api_key.startswith("sk_test_")

    @staticmethod
    def _state_value(state) -> str:
        return str(getattr(state, "value", state) or "")

    def _organization(self, organization) -> WorkOSOrganization:
        verified = frozenset(
            str(domain.domain).strip().lower()
            for domain in organization.domains
            if self._state_value(domain.state) in _VERIFIED_DOMAIN_STATES
        )
        connections = self._sdk().sso.list_connections(organization_id=organization.id, limit=100)
        states = [self._state_value(connection.state) for connection in connections.data]
        return WorkOSOrganization(
            id=str(organization.id),
            name=str(organization.name or ""),
            verified_domains=verified,
            sso_disabled="active" not in states and (bool(states) or not self._is_staging()),
        )

    def get_organization(self, organization_id: str) -> WorkOSOrganization | None:
        import workos

        try:
            return self._organization(self._sdk().organizations.get_organization(organization_id))
        except workos.NotFoundError:
            return None
        except Exception:
            raise EnterpriseSsoError("sso_provider_unavailable", 502) from None

    def find_organization_by_domain(self, domain: str) -> WorkOSOrganization | None:
        """The one organization that has verified this domain and has not had SSO switched off.

        Ambiguity resolves to nothing: if two organizations qualify, neither is
        guessed at.
        """
        try:
            page = self._sdk().organizations.list_organizations(domains=[domain], limit=10)
            matches = [
                candidate
                for candidate in (self._organization(item) for item in page.data)
                if domain in candidate.verified_domains and not candidate.sso_disabled
            ]
        except Exception:
            raise EnterpriseSsoError("sso_provider_unavailable", 502) from None
        return matches[0] if len(matches) == 1 else None

    def authorization_url(
        self,
        *,
        organization_id: str,
        state: str,
        login_hint: str | None,
        redirect_uri: str | None = None,
    ) -> str:
        return self._sdk().sso.get_authorization_url(
            redirect_uri=redirect_uri or self._config.redirect_uri,
            organization=organization_id,
            state=state,
            login_hint=login_hint,
        )

    def exchange_code(self, code: str) -> SsoProfile:
        import workos

        try:
            response = self._sdk().sso.get_profile_and_token(code=code)
        except (workos.BadRequestError, workos.AuthenticationError) as exc:
            reason = str(getattr(exc, "error", "") or "")
            if isinstance(exc, workos.AuthenticationError) or reason == "invalid_client":
                # The API key and Client ID do not belong to the same WorkOS application (or the key
                # is wrong). That is a deployment problem, not something the person did, so say so
                # in the log and answer "unavailable" instead of "your attempt expired".
                logger.error(
                    "enterprise_sso.workos_credentials_rejected reason=%s request_id=%s",
                    reason or type(exc).__name__,
                    getattr(exc, "request_id", None),
                )
                raise EnterpriseSsoError("sso_unavailable", 503) from None
            raise EnterpriseSsoError("sso_code_invalid", 400) from None
        except (workos.AuthorizationError, workos.NotFoundError):
            raise EnterpriseSsoError("sso_code_invalid", 400) from None
        except Exception:
            raise EnterpriseSsoError("sso_provider_unavailable", 502) from None
        profile = response.profile
        return SsoProfile(
            id=str(profile.id),
            organization_id=getattr(profile, "organization_id", None),
            email=str(profile.email or ""),
            first_name=str(getattr(profile, "first_name", None) or "").strip() or None,
            last_name=str(getattr(profile, "last_name", None) or "").strip() or None,
            name=str(getattr(profile, "name", None) or "").strip() or None,
            connection_id=str(getattr(profile, "connection_id", None) or "").strip() or None,
            idp_id=str(getattr(profile, "idp_id", None) or "").strip() or None,
        )

    def directory_membership(self, profile: SsoProfile) -> DirectoryMembership | None:
        """Correlate WorkOS's exact same-organization IdP identifier, never email.

        WorkOS documents this SSO/Directory Sync identity-linking rule. Incomplete
        listings and multiple matches cannot establish attribution. An IdP with
        inconsistent SSO/SCIM identifiers needs explicit configuration/qualification.
        """
        if not profile.organization_id:
            raise EnterpriseSsoError("sso_directory_binding_required", 503)
        try:
            sdk = self._sdk()
            directories = sdk.directory_sync.list_directories(
                organization_id=profile.organization_id, limit=100
            )
            if getattr(directories.list_metadata, "after", None):
                raise EnterpriseSsoError("sso_directory_binding_required", 503)
            if not directories.data:
                # Preserve SSO-only organizations and the built-in Test IdP.
                # An API failure or an unmatched existing directory is never empty.
                return None
            if not profile.connection_id or not profile.idp_id:
                raise EnterpriseSsoError("sso_directory_binding_required", 503)
            connection = sdk.sso.get_connection(profile.connection_id)
            if (
                connection.organization_id != profile.organization_id
                or self._state_value(connection.state) != "active"
            ):
                raise EnterpriseSsoError("sso_directory_binding_required", 503)
            found = []
            for directory in directories.data:
                if (
                    directory.organization_id != profile.organization_id
                    or self._state_value(directory.state) != "linked"
                ):
                    continue
                users = sdk.directory_sync.list_users(
                    directory=directory.id, idp_id=profile.idp_id, limit=2
                )
                if getattr(users.list_metadata, "after", None):
                    raise EnterpriseSsoError("sso_directory_binding_required", 503)
                for user in users.data:
                    if (
                        user.organization_id == profile.organization_id
                        and user.directory_id == directory.id
                        and user.idp_id == profile.idp_id
                        and self._state_value(user.state) == "active"
                    ):
                        found.append(DirectoryMembership(str(directory.id), str(user.id)))
            if len(found) != 1:
                raise EnterpriseSsoError("sso_directory_binding_required", 503)
            return found[0]
        except EnterpriseSsoError:
            raise
        except Exception:
            raise EnterpriseSsoError("sso_provider_unavailable", 502) from None


def verify_webhook_signature(
    body: bytes,
    header: str | None,
    secret: str,
    *,
    now: float | None = None,
    tolerance: int = WEBHOOK_TOLERANCE_SECONDS,
) -> None:
    """Verify ``WorkOS-Signature: t=<epoch ms>,v1=<hex hmac-sha256 of "t.body">``.

    Runs over the exact raw bytes. Every failure raises the same error so the
    response never says whether the format, the age, or the digest was wrong.
    """
    invalid = EnterpriseSsoError("webhook_invalid_signature", 400)
    if not header or not secret:
        raise invalid
    fields = dict(part.strip().split("=", 1) for part in header.split(",") if "=" in part)
    issued, signature = fields.get("t", ""), fields.get("v1", "")
    if not issued.isdigit() or not signature:
        raise invalid
    current = time.time() if now is None else now
    if abs(current - int(issued) / 1000) > tolerance:
        raise invalid
    expected = hmac.new(
        secret.encode("utf-8"), issued.encode("ascii") + b"." + body, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise invalid


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _state_key(api_key: str) -> bytes:
    # Derived, not shared: the API key never signs anything directly.
    return hmac.new(api_key.encode("utf-8"), _STATE_KEY_LABEL, hashlib.sha256).digest()


def sign_state(api_key: str, organization_id: str, *, now: float | None = None) -> str:
    """Opaque, expiring state that carries the org the sign-in was started for.

    The exchange compares the profile's organization to this value, so a code
    minted for another org cannot be redeemed here. The browser must also
    compare the returned state to the one it stored before redirecting.
    """
    issued = time.time() if now is None else now
    payload = _b64(
        json.dumps(
            {
                "o": organization_id,
                "n": secrets.token_urlsafe(12),
                "e": int(issued) + STATE_TTL_SECONDS,
            },
            separators=(",", ":"),
        ).encode("utf-8")
    )
    signature = _b64(
        hmac.new(_state_key(api_key), payload.encode("ascii"), hashlib.sha256).digest()
    )
    return f"{payload}.{signature}"


def verify_state(api_key: str, state: str, *, now: float | None = None) -> str:
    """Return the organization the state was issued for, or refuse."""
    invalid = EnterpriseSsoError("sso_state_invalid", 400)
    payload, _, signature = str(state or "").partition(".")
    if not payload or not signature:
        raise invalid
    expected = _b64(hmac.new(_state_key(api_key), payload.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, signature):
        raise invalid
    try:
        claims = json.loads(_unb64(payload))
        organization_id = str(claims["o"])
        expires = int(claims["e"])
    except (ValueError, KeyError, TypeError):
        raise invalid from None
    if (time.time() if now is None else now) > expires or not organization_id:
        raise invalid
    return organization_id

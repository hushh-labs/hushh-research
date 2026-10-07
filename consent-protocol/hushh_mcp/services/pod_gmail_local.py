"""Gmail read inside the owner's own agent, with the login sealed to that agent.

``GmailMetadataReader`` and ``read_email_metadata`` were written against the hub's
``GmailReceiptsService``: a stored connection row, a token the hub refreshes, and an
observation fence over that row. :class:`PodGmailConnection` is a stand-in for exactly
those three seams (``_fetch_connection_row``, ``_ensure_access_token``,
``_refresh_observation``) backed by the agent's own login (``pod_connector_tokens``),
so the reader and the projection run unchanged and no hub table is ever touched. Any
inherited method that would read a hub table refuses with ``HubTableRefused`` instead
of quietly degrading.

:class:`PodLocalEmailReadPort` is the email specialist's port for an owner-cloud
agent: the same ``EmailReadOptions`` bounds, the same signed ``MailObservation``
round trip (bound here to this agent's login instead of a hub service), and the same
fail-closed ``expect_account`` refusal as the hub-door port it replaces. It is built
with no scope token, so a hub door read from it is impossible rather than avoided.
"""

from __future__ import annotations

import hashlib
import os
import secrets
from typing import Any, Optional

from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services.gmail_metadata_reader import (
    MAIL_READ_ERROR_CODES,
    GmailMetadataError,
    GmailMetadataReader,
)
from hushh_mcp.services.gmail_receipts_service import (
    _GMAIL_MODIFY_SCOPE,
    _GMAIL_PROFILE_URL,
    GmailApiError,
    GmailReceiptsService,
    _clean_text,
)
from hushh_mcp.services.pod_connector_tokens import (
    NEEDS_REAUTH,
    NOT_CONNECTED,
    SCOPE_NOT_GRANTED,
    ConnectorTokenError,
    google_token_source,
    required_scopes,
)
from hushh_mcp.services.pod_specialist_runtime import (
    PodEmailReadPort,
    PodSpecialistInformationUnavailable,
    current_dependency_trace,
)

GMAIL = "gmail"
_READONLY = "https://www.googleapis.com/auth/gmail.readonly"
#: Token refusals as the reader's own words. Anything else is a retry, never a guess.
_TOKEN_CODES = {
    NOT_CONNECTED: "connect_required",
    NEEDS_REAUTH: "reconnect_required",
    SCOPE_NOT_GRANTED: "reconnect_required",
}


class HubTableRefused(RuntimeError):
    """An inherited hub path asked for a database table this agent does not have."""


def _held() -> Optional[store.ConnectorCredential]:
    try:
        return store.active_connector_credential(GMAIL)
    except store.ConnectorCredentialsUnavailable:
        raise GmailMetadataError("retryable") from None


def _satisfies(credential: store.ConnectorCredential, level: str) -> bool:
    try:
        required_scopes(GMAIL, level, credential.granted_scopes)
    except ConnectorTokenError:
        return False
    return True


class PodGmailConnection(GmailReceiptsService):
    """The hub Gmail service's three credential seams, answered from the agent's login."""

    def __init__(self, owner_user_id: str, *, token_source: Any = None) -> None:
        super().__init__()
        self._owner = owner_user_id
        self._source = token_source
        self._email = ""

    @property
    def db(self) -> Any:
        raise HubTableRefused("kai_gmail_connections is a hub table; this agent holds its own")

    def _tokens(self) -> Any:
        return self._source if self._source is not None else google_token_source()

    def is_configured(self) -> bool:
        return True

    def _fetch_connection_row(self, *, user_id: str) -> dict[str, Any] | None:
        if user_id != self._owner:
            return None
        credential = _held()
        if credential is None:
            return None
        scopes = list(credential.granted_scopes)
        if _satisfies(credential, "read") and _READONLY not in scopes:
            # gmail.modify is a superset of readonly; the reader names the read grant.
            scopes.append(_READONLY)
        return {
            "status": "connected"
            if credential.status == store.STATUS_CONNECTED
            else store.STATUS_NEEDS_REAUTH,
            "revoked": False,
            "google_sub": credential.account_subject,
            "google_email": self._email,
            "scope_csv": " ".join(scopes),
            "credential_id": credential.credential_id,
            "generation": credential.generation,
        }

    @staticmethod
    def _refresh_observation(row: dict[str, Any]) -> dict[str, Any]:
        # A reconnect is a new credential id; a rotation or reauth mark a new generation.
        return {
            "observed_credential_id": row.get("credential_id"),
            "observed_generation": f"g{row.get('generation')}",
        }

    async def _token(self, user_id: str, level: str) -> str:
        if user_id != self._owner:
            raise GmailMetadataError("permission_denied")
        try:
            return str(await self._tokens().access_token(GMAIL, level))
        except ConnectorTokenError as exc:
            raise GmailMetadataError(_TOKEN_CODES.get(exc.code, "retryable")) from None

    async def _ensure_access_token(self, *, user_id: str) -> tuple[str, dict[str, Any]]:
        token = await self._token(user_id, "read")
        if not self._email:
            profile = await self._http_get_json(_GMAIL_PROFILE_URL, token=token)
            self._email = _clean_text(profile.get("emailAddress")).lower()
        row = self._fetch_connection_row(user_id=user_id)
        if row is None:
            raise GmailMetadataError("connect_required")
        return token, row

    def _mark_connection_needs_reauth(
        self, *, user_id: str, message: str, observed: dict[str, Any]
    ) -> None:
        # Google refused a fresh token: drop it so the next read refreshes, and a dead
        # login then surfaces as needs_reauth from the token source itself.
        self._tokens().forget(GMAIL)

    def _derive_connection_state(self, row: dict[str, Any] | None) -> str:
        if not row:
            return "not_connected"
        return "connected" if row.get("status") == "connected" else "needs_reauth"

    def modify_permission_granted(self, row: dict[str, Any] | None) -> bool:
        credential = _held()
        return (
            self._derive_connection_state(row) == "connected"
            and credential is not None
            and _satisfies(credential, "manage")
            and _GMAIL_MODIFY_SCOPE in credential.granted_scopes
        )

    async def get_modify_access_token(self, *, user_id: str, expected_google_sub: str) -> str:
        row = self._fetch_connection_row(user_id=user_id)
        if not row or self._derive_connection_state(row) != "connected":
            raise GmailApiError("Connect Gmail first", status_code=409, code="GMAIL_NOT_CONNECTED")
        if not expected_google_sub or row.get("google_sub") != expected_google_sub:
            raise GmailApiError(
                "Your Gmail connection changed. Review this change again.",
                status_code=409,
                code="GMAIL_MAILBOX_CONNECTION_CHANGED",
            )
        try:
            return await self._token(user_id, "manage")
        except GmailMetadataError:
            raise GmailApiError(
                "Allow Gmail changes before organizing mail.",
                status_code=409,
                code="GMAIL_MODIFY_PERMISSION_REQUIRED",
            ) from None


def owner_session_turn(turn_token: str, verifier: Any) -> bool:
    """True only for a turn the pod's own session authority admitted for the owner.

    That turn carries a ``pod-session:`` token and the local verifier that re-checks it
    on every read. A hub-verified consent token is never enough to reach the agent's
    own Gmail login: the hub would then be able to ask for the owner's mail.
    """
    from hushh_mcp.services.pod_session_authority import LOCAL_TOKEN_PREFIX

    return verifier is not None and str(turn_token or "").startswith(LOCAL_TOKEN_PREFIX)


class PodLocalEmailReadPort(PodEmailReadPort):
    """The email specialist's port when the agent holds its own Gmail login.

    It serves only a turn the owner's own session admitted (``owner_session``); any
    other turn is refused before a token is asked for, never sent to the hub door.
    """

    def __init__(
        self,
        owner_user_id: str,
        connection: Optional[PodGmailConnection] = None,
        *,
        owner_session: bool = False,
    ):
        super().__init__(owner_user_id, "")
        self._connection = connection or PodGmailConnection(owner_user_id)
        self._scope_digest = hashlib.sha256(secrets.token_bytes(32)).hexdigest()
        self._owner_session = owner_session

    def require_owner_session(self) -> None:
        if not self._owner_session:
            raise PermissionError("Email on this agent answers only the owner's own session")

    def _context(self) -> tuple[Any, str]:
        from hushh_mcp.services.pod_mail_observation import MailObservationContext
        from hushh_mcp.services.pod_session_authority import expected_environment

        credential = _held()
        if credential is None:
            raise GmailMetadataError("connect_required")
        context = MailObservationContext(
            owner_id=self._owner,
            pod_id=(os.environ.get("HUSSH_ID") or "").strip(),
            service_uid=f"pod-gmail:{credential.credential_id}",
            scope_digest=self._scope_digest,
            environment=expected_environment() or "pod",
        )
        return context, credential.credential_id

    async def _read(self, user_id: str, **options: Any) -> dict:
        self.require_owner_session()
        if user_id != self._owner:
            raise PermissionError("Email owner mismatch")
        from hushh_mcp.services.pod_email_read import EmailReadOptions, read_email_metadata

        query = EmailReadOptions.model_validate(options)
        try:
            context, bound = self._context()

            async def still_bound() -> None:
                held = _held()
                if held is None or held.status != store.STATUS_CONNECTED:
                    raise GmailMetadataError("connection_changed")
                if held.credential_id != bound:
                    raise GmailMetadataError("connection_changed")

            projection: dict = await read_email_metadata(
                self._owner,
                query,
                service=self._connection,
                context=context,
                require_access=still_bound,
                reader_factory=GmailMetadataReader,
            )
            return projection
        except GmailMetadataError as exc:
            # Exactly the codes the hub door returns as 409s; everything else is one state.
            if query.operation not in {"nudges", "search"} and exc.code in MAIL_READ_ERROR_CODES:
                raise GmailMetadataError(exc.code) from None
            raise self._unavailable() from None
        except PermissionError:
            raise
        except Exception:  # noqa: BLE001 - provider and store detail never reach the model
            raise self._unavailable() from None

    @staticmethod
    def _unavailable() -> PodSpecialistInformationUnavailable:
        trace = current_dependency_trace()
        if trace is not None:
            trace.record_unavailable("email")
        return PodSpecialistInformationUnavailable("email")


def email_read_port(
    owner_user_id: str, scope_token: str, turn_token: str = "", verifier: Any = None
) -> PodEmailReadPort:
    """The local port in every owner-cloud agent; the hosted pod uses its hub door.

    An owner-cloud agent whose own login store cannot be read stays local too and
    answers unavailable: falling back to the hub would put this person's mail on the
    hub. A missing login asks the owner to connect on their agent. The
    local port serves only an owner-session turn (:func:`owner_session_turn`); a turn
    the hub admitted gets a local port that refuses, never the hub door.
    """
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent

    if owner_cloud_agent():
        session = owner_session_turn(turn_token, verifier)
        return PodLocalEmailReadPort(owner_user_id, owner_session=session)
    return PodEmailReadPort(owner_user_id, scope_token)


__all__ = [
    "HubTableRefused",
    "PodGmailConnection",
    "PodLocalEmailReadPort",
    "email_read_port",
    "owner_session_turn",
]

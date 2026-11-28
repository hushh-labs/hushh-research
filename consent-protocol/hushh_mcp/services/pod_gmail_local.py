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
import logging
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
logger = logging.getLogger(__name__)


class PodLocalMetadataReader(GmailMetadataReader):
    """An authorized read can settle matching notification IDs, never mark mail read."""

    def calendar_source_credential_id(self) -> str | None:
        if self._observation is None:
            return None
        identifier = self._observation.get("observed_credential_id")
        return identifier if isinstance(identifier, str) else None

    async def read(self, operation: Any, arguments: dict[str, Any]) -> dict[str, Any]:
        from hushh_mcp.services.pod_gmail_doorbell import pod_gmail_doorbell

        bell = pod_gmail_doorbell()
        try:
            await self._require_access()
            delivery = await bell.queued_work()
            if delivery:
                await bell.reconcile_missing(delivery, self._require_access)
        except Exception:  # A unavailable receipt cannot authorize or suppress the normal read.
            delivery = None
        result = await super().read(operation, arguments)
        await self.require_current()
        if delivery and self.offered_message_ids():
            try:
                await bell.acknowledge_read(delivery, self.offered_message_ids())
            except Exception as exc:
                # Keep the work pending; do not claim a durable receipt for a failed save.
                logger.info("pod_gmail_read.receipt_pending reason=%s", type(exc).__name__)
        await self.require_current()
        return result


class HubTableRefused(RuntimeError):
    """An inherited hub path asked for a database table this agent does not have."""


def _hosted_ace_brokered_gmail() -> bool:
    from hushh_mcp.services.pod_hub_client import hub_base_url  # noqa: PLC0415
    from hushh_mcp.services.pod_owner_cloud import (  # noqa: PLC0415
        hosted_ace_runtime,
        owner_cloud_agent,
    )

    return bool(hosted_ace_runtime() and not owner_cloud_agent() and hub_base_url())


def _brokered_gmail_accounts() -> list[dict[str, Any]]:
    if not _hosted_ace_brokered_gmail():
        return []
    from hushh_mcp.services.pod_hub_client import PodHubClient, PodHubUnavailable  # noqa: PLC0415

    try:
        body = PodHubClient().broker_google_connector_token(service=GMAIL, action="accounts")
    except PodHubUnavailable:
        return []
    return [a for a in (body.get("accounts") or []) if isinstance(a, dict) and a.get("connected")]


def _held(account_id: str = "") -> Optional[store.ConnectorCredential]:
    if account_id and account_id != "default" and _hosted_ace_brokered_gmail():
        from hushh_mcp.services.pod_hub_client import (  # noqa: PLC0415
            PodHubClient,
            PodHubUnavailable,
        )

        try:
            body = PodHubClient().broker_google_connector_token(
                service=GMAIL, action="grant", account_id=account_id
            )
        except PodHubUnavailable:
            return None
        status = str(body.get("status") or store.STATUS_ABSENT)
        if status not in {store.STATUS_CONNECTED, store.STATUS_NEEDS_REAUTH}:
            return None
        return store.ConnectorCredential(
            credential_id=str(body.get("credentialId") or f"hub-gmail:{account_id}"),
            connector_id=GMAIL,
            provider="google",
            account_subject=str(body.get("accountSubject") or ""),
            granted_scopes=tuple(str(s) for s in (body.get("grantedScopes") or ())),
            client_profile=store.HUB_BRIDGED_PROFILE,
            client_id="",
            generation=max(1, int(body.get("generation") or 1)),
            status=status,
            connected_at_ms=int(body.get("connectedAtMs") or 1),
            issued_at_ms=0,
            refresh_token="",
            account_id=account_id,
            account_email=str(body.get("accountEmail") or ""),
        )
    try:
        return store.active_connector_credential(
            GMAIL, account_id="" if account_id == "default" else account_id
        )
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

    def __init__(
        self,
        owner_user_id: str,
        *,
        token_source: Any = None,
        account_id: str = "",
        local_grant: store.ConnectorCredential | None = None,
    ) -> None:
        super().__init__()
        self._owner = owner_user_id
        self._account_id = local_grant.account_id if local_grant else account_id
        self._local_selection = (
            (store.public_account_id(local_grant), local_grant.credential_id)
            if local_grant
            else None
        )
        self._source = token_source
        self._email = ""

    def _credential(self) -> Optional[store.ConnectorCredential]:
        if self._local_selection is None:
            return _held(self._account_id)
        # The Mail picker verified a pod-held grant. Re-read that same grant
        # across provider awaits, including when a hosted hub broker also exists.
        account, expected = self._local_selection
        try:
            credential = store.active_mail_account(account)
        except store.ConnectorCredentialsUnavailable:
            raise GmailMetadataError("retryable") from None
        if credential is None or credential.credential_id != expected:
            raise GmailMetadataError("connection_changed")
        return credential

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
        credential = self._credential()
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
        if self._local_selection is not None:
            self._credential()
        elif self._account_id and self._account_id != "default" and _hosted_ace_brokered_gmail():
            import asyncio  # noqa: PLC0415

            from hushh_mcp.services.pod_hub_client import (  # noqa: PLC0415
                PodHubClient,
                PodHubUnavailable,
            )

            try:
                bridged = await asyncio.to_thread(
                    PodHubClient().broker_google_connector_token,
                    service=GMAIL,
                    action="access_token",
                    level=level,
                    account_id=self._account_id,
                )
            except PodHubUnavailable as exc:
                msg = str(exc)
                if "reauth" in msg or "status=401" in msg:
                    raise GmailMetadataError("reconnect_required") from None
                raise GmailMetadataError("retryable") from None
            tok = str(bridged.get("accessToken") or "").strip()
            if not tok:
                raise GmailMetadataError("connect_required")
            return tok
        try:
            if self._account_id and self._account_id != "default":
                return str(
                    await self._tokens().access_token(GMAIL, level, account_id=self._account_id)
                )
            return str(await self._tokens().access_token(GMAIL, level))
        except ConnectorTokenError as exc:
            raise GmailMetadataError(_TOKEN_CODES.get(exc.code, "retryable")) from None

    async def _ensure_access_token(self, *, user_id: str) -> tuple[str, dict[str, Any]]:
        token = await self._token(user_id, "read")
        if not self._email:
            # Google supplied this address with the selected account's OAuth grant.
            # Older grants without an address still resolve it from Gmail.
            held = self._credential()
            self._email = held.account_email if held else ""
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
        self._tokens().forget(
            GMAIL, account_id=self._account_id
        ) if self._account_id else self._tokens().forget(GMAIL)

    def _derive_connection_state(self, row: dict[str, Any] | None) -> str:
        if not row:
            return "not_connected"
        return "connected" if row.get("status") == "connected" else "needs_reauth"

    def modify_permission_granted(self, row: dict[str, Any] | None) -> bool:
        credential = self._credential()
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

    async def preflight_mail_read_status(self, *, user_id: str) -> str | None:
        """Check owner-local Gmail readiness before spending a planner LLM turn."""
        self.require_owner_session()
        if user_id != self._owner:
            raise PermissionError("Email owner mismatch")
        try:
            status = await self._connection.preflight_mail_read_status(user_id=user_id)
            if status == "connect_required" and not self._connection._account_id:
                extra = [a for a in _brokered_gmail_accounts() if a.get("account_id") != "default"]
                if extra:
                    self._connection = PodGmailConnection(
                        self._owner, account_id=str(extra[0]["account_id"])
                    )
                    return await self._connection.preflight_mail_read_status(user_id=user_id)
            return status
        except GmailMetadataError as exc:
            return exc.code if exc.code in MAIL_READ_ERROR_CODES else "unavailable"
        except Exception:  # noqa: BLE001 - storage failure never leaks store details
            return "unavailable"

    def metadata_reader(
        self, *, gmail: Any, user_id: str, require_access: Any, expect_account: str = ""
    ) -> GmailMetadataReader:
        self.require_owner_session()
        if user_id != self._owner or gmail is not self:
            raise PermissionError("Email owner mismatch")
        held = _held()
        if expect_account and (held is None or held.account_subject != expect_account):
            raise GmailMetadataError("connection_changed")
        bound = held.credential_id if held else None

        async def authorized() -> None:
            self.require_owner_session()
            await require_access()
            current = _held()
            if bound and (current is None or current.credential_id != bound):
                raise GmailMetadataError("connection_changed")

        return PodLocalMetadataReader(
            gmail=self._connection,
            user_id=user_id,
            require_access=authorized,
            expect_account=expect_account or None,
            expose_message_links=True,
        )

    def _context(self) -> tuple[Any, str]:
        from hushh_mcp.services.pod_mail_observation import MailObservationContext
        from hushh_mcp.services.pod_session_authority import expected_environment

        credential = _held(self._connection._account_id)
        if credential is None and not self._connection._account_id:
            extra = [a for a in _brokered_gmail_accounts() if a.get("account_id") != "default"]
            if extra:
                fallback_id = str(extra[0]["account_id"])
                self._connection = PodGmailConnection(self._owner, account_id=fallback_id)
                credential = _held(fallback_id)
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
                held = _held(self._connection._account_id)
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
                reader_factory=PodLocalMetadataReader,
            )
            if query.operation in {"search", "list_recent"} and _hosted_ace_brokered_gmail():
                active_slot = self._connection._account_id or "default"
                extras = [
                    a
                    for a in _brokered_gmail_accounts()
                    if str(a.get("account_id") or "") not in {"", active_slot}
                ]
                for extra_acct in extras:
                    extra_id = str(extra_acct["account_id"])
                    extra_email = str(extra_acct.get("google_email") or "").strip()
                    extra_conn = PodGmailConnection(self._owner, account_id=extra_id)
                    extra_cred = _held(extra_id)
                    if extra_cred is None or extra_cred.status != store.STATUS_CONNECTED:
                        continue
                    from hushh_mcp.services.pod_mail_observation import MailObservationContext
                    from hushh_mcp.services.pod_session_authority import expected_environment

                    extra_ctx = MailObservationContext(
                        owner_id=self._owner,
                        pod_id=(os.environ.get("HUSSH_ID") or "").strip(),
                        service_uid=f"pod-gmail:{extra_cred.credential_id}",
                        scope_digest=self._scope_digest,
                        environment=expected_environment() or "pod",
                    )

                    async def extra_bound(
                        cid: str = extra_cred.credential_id, aid: str = extra_id
                    ) -> None:
                        cur = _held(aid)
                        if (
                            cur is None
                            or cur.status != store.STATUS_CONNECTED
                            or cur.credential_id != cid
                        ):
                            raise GmailMetadataError("connection_changed")

                    try:
                        extra_proj = await read_email_metadata(
                            self._owner,
                            query,
                            service=extra_conn,
                            context=extra_ctx,
                            require_access=extra_bound,
                            reader_factory=PodLocalMetadataReader,
                        )
                    except Exception:  # noqa: BLE001
                        continue
                    extra_items = extra_proj.get("items") or extra_proj.get("messages")
                    target_key = (
                        "items"
                        if "items" in projection
                        else ("messages" if "messages" in projection else None)
                    )
                    if (
                        isinstance(extra_items, list)
                        and target_key
                        and isinstance(projection.get(target_key), list)
                    ):
                        for item in extra_items:
                            if isinstance(item, dict):
                                tagged = dict(item)
                                if extra_email and "account_email" not in tagged:
                                    tagged["account_email"] = extra_email
                                projection[target_key].append(tagged)
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
    from hushh_mcp.services.pod_owner_cloud import personal_sandbox_workspace_runtime

    if personal_sandbox_workspace_runtime():
        session = owner_session_turn(turn_token, verifier)
        return PodLocalEmailReadPort(owner_user_id, owner_session=session)
    return PodEmailReadPort(owner_user_id, scope_token)


def current_calendar_mail_grant(owner_id: str, credential_id: str, account: str) -> bool:
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent, pod_owner_user_id

    if not owner_cloud_agent() or not owner_id or owner_id != pod_owner_user_id():
        return False
    held = _held()
    return bool(
        held
        and held.credential_id == credential_id
        and held.account_subject == account
        and held.status == store.STATUS_CONNECTED
        and _satisfies(held, "read")
    )


async def calendar_mail_source(
    *, owner_id: str, credential_id: str, account: str, message_id: str, require_access: Any
) -> tuple[dict[str, Any], str]:
    async def authorized() -> None:
        await require_access()
        if not current_calendar_mail_grant(owner_id, credential_id, account):
            raise GmailMetadataError("connection_changed")

    await authorized()
    port = PodLocalEmailReadPort(owner_id, owner_session=True)
    reader = port.metadata_reader(
        gmail=port, user_id=owner_id, require_access=authorized, expect_account=account
    )
    message = await reader.reply_source(message_id)
    await authorized()
    return message, port._connection._email


__all__ = [
    "HubTableRefused",
    "PodGmailConnection",
    "PodLocalEmailReadPort",
    "email_read_port",
    "owner_session_turn",
]

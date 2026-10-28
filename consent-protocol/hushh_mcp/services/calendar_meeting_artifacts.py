"""Exact provider references only; live per-file checks, no ingestion or PKM writes."""

from __future__ import annotations

import asyncio
import json
from http.client import HTTPSConnection
from urllib.parse import parse_qsl, urlencode, urlparse

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.calendar_insights_service import CalendarInsightsService
from hushh_mcp.services.calendar_meeting_common import ArtifactUnavailable
from hushh_mcp.services.calendar_meeting_provider import collect_meet_pages, meet_request
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_connection_service import (
    CALENDAR_MEET_DRIVE_READ_SCOPE,
    CALENDAR_MEET_READ_SCOPE,
    CalendarGrantIdentity,
)
from hushh_mcp.services.google_drive_adapter import (
    LIVE_POLICY_HASH as LIVE_POLICY_HASH,
)
from hushh_mcp.services.google_drive_adapter import (
    RESOURCE_KEY,
    DriveReadError,
    GoogleDriveAdapter,
)

MEET_SCOPES = {CALENDAR_MEET_READ_SCOPE, "https://www.googleapis.com/auth/meetings.space.created"}


def _drive_error_state(error: DriveReadError) -> str:
    if str(error) == "reconnect_required":
        return "temporarily_unavailable"
    if error.status_code == 403:
        return error.provider_reason or "resource_denied"
    if str(error) == "operation_not_allowed":
        return "resource_denied"
    if str(error) == "identity_not_verified":
        return "account_mismatch"
    if error.retryable or str(error) == "provider_response_invalid":
        return "temporarily_unavailable"
    return "unavailable"


def source_url(value, resource_key=None):
    try:
        parsed = urlparse(value or "")
        if not (
            parsed.scheme == "https"
            and parsed.hostname in {"drive.google.com", "docs.google.com"}
            and not parsed.username
            and not parsed.password
            and parsed.port in (None, 443)
        ):
            return None
        if resource_key and RESOURCE_KEY.fullmatch(resource_key):
            query = parse_qsl(parsed.query, keep_blank_values=True)
            parsed = parsed._replace(
                query=urlencode(
                    [
                        *((key, value) for key, value in query if key.casefold() != "resourcekey"),
                        ("resourcekey", resource_key),
                    ]
                )
            )
        return parsed.geturl()
    except ValueError:
        return None


async def inspect_token(token, subject):
    # Fixed HTTPS origin, no redirects or request-URL telemetry. The bearer query
    # is never handed to a general URL opener or a logging HTTP client.
    def read():
        connection = HTTPSConnection("oauth2.googleapis.com", timeout=8)
        try:
            with suppress_instrumentation():
                connection.request("GET", "/tokeninfo?" + urlencode({"access_token": token}))
                response = connection.getresponse()
                if response.status in (400, 401):
                    raise ArtifactUnavailable("token_rejected")
                if response.status != 200:
                    raise ValueError()
                raw = response.read(65537)
                if len(raw) > 65536:
                    raise ValueError()
                return json.loads(raw)
        finally:
            connection.close()

    try:
        info = await asyncio.to_thread(read)
        if info.get("sub") != subject:
            raise ArtifactUnavailable("account_mismatch")
        if int(info.get("expires_in", 0)) <= 0:
            raise ArtifactUnavailable("token_rejected")
        return set(info.get("scope", "").split())
    except ArtifactUnavailable:
        raise
    except Exception:
        raise ArtifactUnavailable("temporarily_unavailable") from None


def _fold_availability(states, artifacts, discovery):
    for kind in ("recording", "notes", "transcript"):
        files = [a for a in artifacts if a["kind"] == kind and not a.get("linked_only")]
        if files:
            states[kind] = next(
                (
                    state
                    for state in (
                        "permission_required",
                        "account_mismatch",
                        "provider_configuration",
                        "provider_policy",
                        "resource_denied",
                        "temporarily_unavailable",
                        "source_changed",
                        "unavailable",
                    )
                    if any(a["state"] == state for a in files)
                ),
                states.get(kind, "available")
                if any(a["state"] == "available" for a in files)
                else files[0]["state"],
            )
        else:
            states.setdefault(kind, discovery if discovery != "checked" else "unavailable")


class CalendarMeetingArtifacts:
    def __init__(self, insights=None, drive=None, oauth=None):
        self.insights = insights or CalendarInsightsService()
        self.drive = drive or GoogleDriveAdapter()
        # Browse uses the selected Calendar grant. Legacy chat retains its
        # separately verified Drive connector authority.
        self.oauth = oauth or get_external_connector_oauth_service().drive()

    async def _selected_token(self, user_id, grant, *, force_refresh=False):
        """Verify the selected account's live scopes, refreshing one rejected bearer."""
        await self.insights.calendar._check_read_binding(user_id, grant.binding)
        token = await self.insights.calendar.connections.access_token(
            user_id=user_id,
            service="calendar",
            access_level="read",
            **({"force_refresh": True} if force_refresh else {}),
        )
        try:
            scopes = await inspect_token(token, grant.provider_subject)
        except ArtifactUnavailable as error:
            if error.state != "token_rejected":
                raise
            if force_refresh:
                raise ArtifactUnavailable("temporarily_unavailable") from None
            token = await self.insights.calendar.connections.access_token(
                user_id=user_id, service="calendar", access_level="read", force_refresh=True
            )
            try:
                scopes = await inspect_token(token, grant.provider_subject)
            except ArtifactUnavailable as second:
                raise ArtifactUnavailable(
                    "temporarily_unavailable" if second.state == "token_rejected" else second.state
                ) from None
        await self.insights.calendar._check_read_binding(user_id, grant.binding)
        if CALENDAR_MEET_READ_SCOPE not in scopes or CALENDAR_MEET_DRIVE_READ_SCOPE not in scopes:
            raise ArtifactUnavailable("permission_required")
        return token

    async def _meet(self, token, path, params=None):
        return await meet_request(token, path, params)

    async def _meet_pages(self, token, path, field, params=None, *, page_size=100):
        return await collect_meet_pages(self._meet, token, path, field, params, page_size=page_size)

    async def _references(
        self, user_id, grant: CalendarGrantIdentity, event, calendar_id, *, for_chat=False
    ):
        from hushh_mcp.services.calendar_meeting_references import meeting_references

        return await meeting_references(
            self,
            user_id,
            grant,
            event,
            calendar_id,
            for_chat=for_chat,
            inspect_token=inspect_token,
            meet_scopes=MEET_SCOPES,
        )

    async def _file_for_chat(self, user_id, grant: CalendarGrantIdentity, ref, *, content):
        from hushh_mcp.services.calendar_meeting_chat_file import chat_file

        return await chat_file(
            self,
            user_id,
            grant,
            ref,
            content=content,
            inspect_token=inspect_token,
            connector_feature_enabled=connector_feature_enabled,
            source_url=source_url,
        )

    async def _browse_file_facts(self, ref, token, check):
        source_kwargs = {"file_id": ref["file_id"], "access_token": token}
        if ref.get("resource_key"):
            source_kwargs["resource_key"] = ref["resource_key"]
        source_facts = await self.drive.get_file_facts(**source_kwargs)
        await check()
        facts = source_facts
        target_kwargs = source_kwargs
        shortcut_source = source_facts["mimeType"] == "application/vnd.google-apps.shortcut"
        if shortcut_source:
            shortcut = source_facts.get("shortcutDetails") or {}
            target_id = shortcut.get("targetId")
            if not isinstance(target_id, str):
                raise ArtifactUnavailable("unverified")
            target_kwargs = {"file_id": target_id, "access_token": token}
            if shortcut.get("targetResourceKey"):
                target_kwargs["resource_key"] = shortcut["targetResourceKey"]
            facts = await self.drive.get_file_facts(**target_kwargs)
            await check()
            if facts["mimeType"] != shortcut.get("targetMimeType"):
                raise ArtifactUnavailable("source_changed")
        return source_facts, facts, source_kwargs, target_kwargs, shortcut_source

    async def _preview_browse_note(self, ref, token, check, result, shortcut_source):
        if shortcut_source:
            result["preview_state"] = "unavailable"
            return
        try:
            before = await self.drive.get_metadata(
                file_id=ref["file_id"],
                access_token=token,
                require_app_authorized=False,
                require_genai_eligibility=False,
            )
            await check()
            text_mime, raw = await self.drive.read_live_bytes(
                file_id=ref["file_id"], mime_type=before.mime_type, access_token=token
            )
            await check()
            after = await self.drive.get_metadata(
                file_id=ref["file_id"],
                access_token=token,
                require_app_authorized=False,
                require_genai_eligibility=False,
            )
            await check()
            if before != after:
                raise ArtifactUnavailable("source_changed")
            if text_mime in {"text/plain", "text/markdown"}:
                note = raw.decode("utf-8")
                result.update(
                    text=note[:40000],
                    truncated=len(note) > 40000,
                    text_format="markdown" if text_mime == "text/markdown" else "plain",
                )
            else:
                result["preview_state"] = "unsupported_format"
        except (DriveReadError, UnicodeError, ArtifactUnavailable):
            result["preview_state"] = "unavailable"

    async def _file(self, user_id, grant: CalendarGrantIdentity, ref, *, content, for_chat=False):
        if for_chat:
            return await self._file_for_chat(user_id, grant, ref, content=content)
        public_ref = {key: value for key, value in ref.items() if key != "resource_key"}
        result = {**public_ref, "state": "permission_required"}
        try:

            async def check():
                await self.insights.calendar._check_read_binding(user_id, grant.binding)

            await check()
            token = await self._selected_token(user_id, grant)
            await check()
            try:
                (
                    source_facts,
                    facts,
                    source_kwargs,
                    target_kwargs,
                    shortcut_source,
                ) = await self._browse_file_facts(ref, token, check)
            except DriveReadError as error:
                if error.retryable:
                    await asyncio.sleep(0.2)
                    (
                        source_facts,
                        facts,
                        source_kwargs,
                        target_kwargs,
                        shortcut_source,
                    ) = await self._browse_file_facts(ref, token, check)
                elif str(error) != "reconnect_required":
                    raise
                else:
                    token = await self._selected_token(user_id, grant, force_refresh=True)
                    (
                        source_facts,
                        facts,
                        source_kwargs,
                        target_kwargs,
                        shortcut_source,
                    ) = await self._browse_file_facts(ref, token, check)
            if shortcut_source:
                result["file_id"] = target_kwargs["file_id"]
            mime = facts["mimeType"]
            if (
                ref["kind"] == "recording"
                and not mime.startswith("video/")
                or ref["kind"] == "notes"
                and mime
                not in {"application/vnd.google-apps.document", "text/plain", "text/markdown"}
            ):
                raise ArtifactUnavailable("unsupported_format")
            file_resource_key = target_kwargs.get("resource_key") or facts.get("resourceKey")
            link = source_url(facts.get("viewUrl"), file_resource_key)
            can_download = (facts.get("capabilities") or {}).get("canDownload") is True
            result.update(
                state="available",
                title=facts["title"],
                url=link,
                mime_type=mime,
                can_download=can_download,
                download_url=source_url(facts.get("downloadUrl"), file_resource_key)
                if can_download
                else None,
                pdf_export_url=source_url(facts.get("pdfExportUrl"), file_resource_key)
                if can_download
                else None,
            )
            if content and ref["kind"] == "notes" and can_download:
                await self._preview_browse_note(ref, token, check, result, shortcut_source)
            # A file can stay viewable when download or text extraction is prohibited.
            if await self.drive.get_file_facts(**target_kwargs) != facts or (
                target_kwargs != source_kwargs
                and await self.drive.get_file_facts(**source_kwargs) != source_facts
            ):
                raise ArtifactUnavailable("source_changed")
            await check()
            return result
        except ArtifactUnavailable as error:
            return {**public_ref, "state": error.state}
        except DriveReadError as error:
            return {**public_ref, "state": _drive_error_state(error)}
        except (UnicodeError, httpx.HTTPError):
            return {**public_ref, "state": "temporarily_unavailable"}

    async def detail(
        self,
        *,
        user_id,
        calendar_id,
        event_id,
        expected_account_email=None,
        expected_grant=None,
        occurrence_id=None,
        date=None,
        time_zone=None,
        content=True,
        for_chat=False,
    ):
        grant, event = await self.insights.raw_event(
            user_id=user_id,
            calendar_id=calendar_id,
            event_id=event_id,
            expected_account_email=expected_account_email,
            expected_grant=expected_grant,
            occurrence_id=occurrence_id,
            date=date,
            time_zone=time_zone,
        )
        drive_before = (
            await self.oauth.lifecycle.read(user_id=user_id, connector_id="google_drive")
            if for_chat
            else None
        )
        refs, discovery, states = await self._references(
            user_id, grant, event, calendar_id, for_chat=for_chat
        )
        artifacts = []
        if len(refs) > 1000:
            discovery = "temporarily_unavailable"
            refs = refs[:1000]
        for ref in refs:
            artifacts.append(
                await self._file(user_id, grant, ref, content=content, for_chat=for_chat)
            )
        await self.insights.calendar._check_read_binding(user_id, grant.binding)
        if for_chat:
            drive_after = await self.oauth.lifecycle.read(
                user_id=user_id, connector_id="google_drive"
            )
            fence = ("connection_generation", "status", "validation_state", "verified_policy_hash")
            if tuple((drive_before or {}).get(key) for key in fence) != tuple(
                (drive_after or {}).get(key) for key in fence
            ):
                artifacts = [
                    {
                        "file_id": item["file_id"],
                        "kind": item["kind"],
                        "state": "permission_required",
                    }
                    for item in artifacts
                ]
        _fold_availability(states, artifacts, discovery)
        return {
            "availability": states,
            "event": self.insights.calendar._event_summary(event),
            "calendar_id": calendar_id,
            "discovery": discovery,
            "complete": len(refs) <= 1000
            and discovery in {"checked", "unavailable"}
            and all(a["state"] == "available" for a in artifacts),
            "artifacts": artifacts,
            "account_id": grant.account_id,
            "grant_id": expected_grant,
        }

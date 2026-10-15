"""Exact provider references only; live per-file checks, no ingestion or PKM writes."""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime
from http.client import HTTPSConnection
from urllib.parse import urlencode, urlparse

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.calendar_insights_service import CalendarInsightsService
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    FILE_ID,
    LIVE_POLICY_HASH,
    POLICY_HASH,
    DriveReadError,
    GoogleDriveAdapter,
    supports_selected_policy,
)

MEET_SCOPES = {
    "https://www.googleapis.com/auth/meetings.space.readonly",
    "https://www.googleapis.com/auth/meetings.space.created",
}


class ArtifactUnavailable(Exception):
    def __init__(self, state):
        self.state = state


def source_url(value):
    try:
        parsed = urlparse(value or "")
        return (
            value
            if parsed.scheme == "https"
            and parsed.hostname in {"drive.google.com", "docs.google.com"}
            and not parsed.username
            and not parsed.password
            and parsed.port in (None, 443)
            else None
        )
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
                if response.status in (400, 401, 403):
                    raise ArtifactUnavailable("permission_required")
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
        if info.get("sub") != subject or int(info.get("expires_in", 0)) <= 0:
            raise ArtifactUnavailable("permission_required")
        return set(info.get("scope", "").split())
    except ArtifactUnavailable:
        raise
    except Exception:
        raise ArtifactUnavailable("temporarily_unavailable") from None


class CalendarMeetingArtifacts:
    def __init__(self, insights=None, drive=None, oauth=None):
        self.insights = insights or CalendarInsightsService()
        self.drive = drive or GoogleDriveAdapter()
        self.oauth = oauth or get_external_connector_oauth_service().drive()

    async def _meet(self, token, path, params=None):
        async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
            with suppress_instrumentation():
                async with client.stream(
                    "GET",
                    "https://meet.googleapis.com/v2/" + path,
                    headers={"Authorization": f"Bearer {token}"},
                    params=params,
                ) as response:
                    if response.status_code in (401, 403):
                        raise ArtifactUnavailable("permission_required")
                    if response.status_code == 404:
                        raise ArtifactUnavailable("unavailable")
                    if response.status_code != 200:
                        raise ArtifactUnavailable("temporarily_unavailable")
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        raw.extend(chunk)
                        if len(raw) > 262144:
                            raise ArtifactUnavailable("temporarily_unavailable")
                    result = json.loads(raw)
                    if not isinstance(result, dict):
                        raise ArtifactUnavailable("temporarily_unavailable")
                    return result

    async def _references(self, user_id, binding, event):
        refs = []
        states = {}
        # Attachments are linked by provider fileId, never by their title or URL.
        for attachment in event.get("attachments", []):
            if not isinstance(attachment, dict) or not FILE_ID.fullmatch(
                str(attachment.get("fileId", ""))
            ):
                continue
            mime = attachment.get("mimeType", "")
            kind = (
                "recording"
                if mime.startswith("video/")
                else "notes"
                if mime in {"application/vnd.google-apps.document", "text/plain"}
                else None
            )
            if kind:
                refs.append(
                    {
                        "file_id": attachment["fileId"],
                        "kind": kind,
                        "association": "calendar_attachment",
                        "linked_only": True,
                    }
                )
        conference = event.get("conferenceData") or {}
        code = conference.get("conferenceId", "")
        if (conference.get("conferenceSolution") or {}).get("key", {}).get(
            "type"
        ) != "hangoutsMeet" or not re.fullmatch(r"[a-z]{3}-[a-z]{4}-[a-z]{3}", code):
            return refs, "unavailable", states
        calendar = self.insights.calendar

        async def check():
            await calendar._check_read_binding(user_id, binding)

        try:
            await check()
            token = await calendar.connections.access_token(
                user_id=user_id, service="calendar", access_level="read"
            )
            scopes = await inspect_token(token, binding[2])
            await check()
            if not scopes & MEET_SCOPES:
                raise ArtifactUnavailable("permission_required")
            start, end = ((event.get(k) or {}).get("dateTime") for k in ("start", "end"))
            if not start or not end:
                raise ArtifactUnavailable("unverified")
            begin, finish = (datetime.fromisoformat(v.replace("Z", "+00:00")) for v in (start, end))
            if begin.tzinfo is None or finish.tzinfo is None:
                raise ArtifactUnavailable("unverified")
            records = await self._meet(
                token,
                "conferenceRecords",
                {
                    "filter": f'space.meeting_code = "{code}" AND end_time > "{begin.isoformat()}" AND start_time < "{finish.isoformat()}"',
                    "pageSize": 10,
                },
            )
            await check()
            matches = records.get("conferenceRecords", [])
            if records.get("nextPageToken") or len(matches) > 1:
                raise ArtifactUnavailable("unverified")
            if not matches:
                return refs, "unavailable", states
            record = matches[0]
            name = record.get("name", "")
            if not re.fullmatch(r"conferenceRecords/[A-Za-z0-9_-]+", name):
                raise ArtifactUnavailable("unverified")
            for resource, kind, destination, key in [
                ("recordings", "recording", "driveDestination", "file"),
                ("smartNotes", "notes", "docsDestination", "document"),
                ("transcripts", "transcript", "docsDestination", "document"),
            ]:
                try:
                    data = await self._meet(token, f"{name}/{resource}", {"pageSize": 100})
                    await check()
                    if data.get("nextPageToken") or not isinstance(data.get(resource, []), list):
                        raise ArtifactUnavailable("temporarily_unavailable")
                    states[kind] = "not_generated"
                    for item in data.get(resource, []):
                        state = item.get("state")
                        if state in {"STARTED", "ENDED"}:
                            states[kind] = "processing"
                        elif state == "FILE_GENERATED":
                            identifier = (item.get(destination) or {}).get(key, "")
                            if not FILE_ID.fullmatch(identifier):
                                raise ArtifactUnavailable("temporarily_unavailable")
                            refs.append(
                                {
                                    "file_id": identifier,
                                    "kind": kind,
                                    "association": item.get("name"),
                                }
                            )
                            if states[kind] != "processing":
                                states[kind] = "available"
                        else:
                            raise ArtifactUnavailable("temporarily_unavailable")
                except ArtifactUnavailable as error:
                    states[kind] = error.state
                except (ValueError, TypeError, AttributeError):
                    states[kind] = "temporarily_unavailable"
            discovery = next(
                (
                    state
                    for state in (
                        "permission_required",
                        "temporarily_unavailable",
                        "processing",
                        "unavailable",
                    )
                    if state in states.values()
                ),
                "checked",
            )
            return list({r["file_id"]: r for r in refs}.values()), discovery, states
        except ArtifactUnavailable as error:
            return refs, error.state, states
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            return refs, "temporarily_unavailable", states

    async def _file(self, user_id, binding, ref, *, content):
        result = {**ref, "state": "permission_required"}
        try:
            row, credential = await self.oauth.current_credential(user_id=user_id)
            profile = credential.get("profile", "selected")
            policy = LIVE_POLICY_HASH if profile == "live" else POLICY_HASH
            feature = "google_drive_live" if profile == "live" else "google_drive_picker"

            async def check():
                if profile == "selected":
                    connector, _, _ = await self.oauth._configuration()
                    if (
                        connector.transport_kind != "google_drive_rest"
                        or connector.mcp_endpoint != DRIVE_BASE
                        or not supports_selected_policy(connector.capability_policy)
                    ):
                        raise ArtifactUnavailable("permission_required")
                await self.insights.calendar._check_read_binding(user_id, binding)
                current = await self.oauth.lifecycle.read(
                    user_id=user_id, connector_id="google_drive"
                )
                if (
                    not connector_feature_enabled(feature, user_id)
                    or credential.get("subject") != binding[2]
                    or not current
                    or current.get("status") != "connected"
                    or current.get("validation_state") != "verified"
                    or current.get("verified_policy_hash") != policy
                    or current.get("connection_generation") != row["connection_generation"]
                ):
                    raise ArtifactUnavailable("permission_required")

            await check()
            token = credential["accessToken"]
            scopes = await inspect_token(token, binding[2])
            permitted = {
                "https://www.googleapis.com/auth/drive",
                "https://www.googleapis.com/auth/drive.readonly",
            }
            if profile == "selected":
                permitted = {"https://www.googleapis.com/auth/drive.file"}
            if not scopes & permitted:
                raise ArtifactUnavailable("permission_required")
            await check()
            facts = await self.drive.get_file_facts(file_id=ref["file_id"], access_token=token)
            await check()
            link = source_url(facts.get("viewUrl"))
            # An exact successful files.get is per-file read permission; content has stricter checks.
            result.update(state="available", title=facts["title"], url=link, can_ask=False)
            if content and ref["kind"] != "recording":
                before = await self.drive.get_metadata(
                    file_id=ref["file_id"],
                    access_token=token,
                    require_app_authorized=profile == "selected",
                    require_genai_eligibility=True,
                )
                await check()
                mime, raw = await self.drive.read_live_bytes(
                    file_id=ref["file_id"], mime_type=before.mime_type, access_token=token
                )
                await check()
                after = await self.drive.get_metadata(
                    file_id=ref["file_id"],
                    access_token=token,
                    require_app_authorized=profile == "selected",
                    require_genai_eligibility=True,
                )
                await check()
                if before != after:
                    raise ArtifactUnavailable("source_changed")
                if mime != "text/plain":
                    raise ArtifactUnavailable("unsupported_format")
                text = raw.decode("utf-8")
                result.update(text=text[:40000], truncated=len(text) > 40000, can_ask=bool(link))
            # Recheck metadata even for recording links, after all prior calls.
            if await self.drive.get_file_facts(file_id=ref["file_id"], access_token=token) != facts:
                raise ArtifactUnavailable("source_changed")
            await check()
            return result
        except ArtifactUnavailable as error:
            return {**ref, "state": error.state}
        except DriveOAuthError as error:
            return {
                **ref,
                "state": "temporarily_unavailable"
                if error.status_code >= 500 or str(error) == "refresh_in_progress"
                else "permission_required",
            }
        except DriveReadError as error:
            return {
                **ref,
                "state": "permission_required"
                if error.status_code == 403
                or str(error)
                in {"reconnect_required", "operation_not_allowed", "identity_not_verified"}
                else "temporarily_unavailable"
                if error.retryable or str(error) == "provider_response_invalid"
                else "unavailable",
            }
        except (UnicodeError, httpx.HTTPError):
            return {**ref, "state": "temporarily_unavailable"}

    async def detail(
        self, *, user_id, calendar_id, event_id, expected_account_email=None, content=True
    ):
        binding, event = await self.insights.raw_event(
            user_id=user_id,
            calendar_id=calendar_id,
            event_id=event_id,
            expected_account_email=expected_account_email,
        )
        drive_before = await self.oauth.lifecycle.read(user_id=user_id, connector_id="google_drive")
        refs, discovery, states = await self._references(user_id, binding, event)
        artifacts = []
        for ref in refs[:12]:
            artifacts.append(await self._file(user_id, binding, ref, content=content))
        await self.insights.calendar._check_read_binding(user_id, binding)
        drive_after = await self.oauth.lifecycle.read(user_id=user_id, connector_id="google_drive")
        fence_keys = ("connection_generation", "status", "validation_state", "verified_policy_hash")
        if tuple((drive_before or {}).get(k) for k in fence_keys) != tuple(
            (drive_after or {}).get(k) for k in fence_keys
        ):
            artifacts = [
                {"file_id": a["file_id"], "kind": a["kind"], "state": "permission_required"}
                for a in artifacts
            ]
        for kind in ("recording", "notes", "transcript"):
            files = [a for a in artifacts if a["kind"] == kind and not a.get("linked_only")]
            if files:
                states[kind] = next(
                    (
                        state
                        for state in (
                            "permission_required",
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
        return {
            "availability": states,
            "event": self.insights.calendar._event_summary(event),
            "calendar_id": calendar_id,
            "discovery": discovery,
            "complete": len(refs) <= 12 and discovery in {"checked", "unavailable"},
            "artifacts": artifacts,
        }

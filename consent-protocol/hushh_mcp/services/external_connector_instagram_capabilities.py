"""Bounded Instagram Graph operations for an owner-connected professional account.

This is a transport/validation service, not an agent tool or public route. The
caller must supply a Vault Owner identity and obtain explicit owner approval
before invoking a write. No provider response or credential enters an error.

Meta references (Instagram Login, graph.instagram.com, checked 2026-10-07):
https://developers.facebook.com/documentation/instagram-platform/content-publishing.md
https://developers.facebook.com/documentation/instagram-platform/comment-moderation.md
https://developers.facebook.com/documentation/instagram-platform/insights.md
https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api.md
https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api.md
https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/mentions.md
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import math
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Awaitable, Callable, Literal
from urllib.parse import urlsplit

import httpx

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.external_connector_instagram_oauth import (
    GRAPH_BASE,
    POLICY_HASH,
    InstagramConnectorError,
)

_NUMERIC_ID = re.compile(r"^[0-9]{1,32}$")
_OPAQUE_ID = re.compile(r"^[A-Za-z0-9_-]{1,512}$")
_CURSOR = re.compile(r"^[A-Za-z0-9_-]{1,512}$")
_MAX_RESPONSE_BYTES = 512_000
_PUBLISH_SCOPE = "instagram_business_content_publish"
_COMMENTS_SCOPE = "instagram_business_manage_comments"
_INSIGHTS_SCOPE = "instagram_business_manage_insights"
_MESSAGES_SCOPE = "instagram_business_manage_messages"
_ACCOUNT_METRICS = frozenset(
    {"reach", "views", "accounts_engaged", "total_interactions", "profile_links_taps"}
)
_MEDIA_METRICS = frozenset(
    {
        "reach",
        "views",
        "likes",
        "comments",
        "saved",
        "shares",
        "total_interactions",
        "ig_reels_avg_watch_time",
        "ig_reels_video_view_total_time",
    }
)
_CONTAINER_KINDS = frozenset({"photo", "reel", "carousel", "story", "photo_child", "video_child"})


@dataclass(frozen=True)
class _Binding:
    owner_id: str = field(repr=False)
    account_id: str
    generation: int
    version: int
    access_token: str = field(repr=False)


def _id(value: object, *, opaque: bool = False) -> str:
    value = str(value or "")
    if not (_OPAQUE_ID if opaque else _NUMERIC_ID).fullmatch(value):
        raise InstagramConnectorError("invalid_graph_id")
    return value


def _text(value: object, *, maximum: int, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise InstagramConnectorError(f"invalid_{label}")
    if any(ord(char) < 32 and char not in "\n\t" for char in value):
        raise InstagramConnectorError(f"invalid_{label}")
    return value


def _caption(value: object) -> str:
    if not isinstance(value, str) or len(value) > 2200:
        raise InstagramConnectorError("invalid_caption")
    if any(ord(char) < 32 and char not in "\n\t" for char in value):
        raise InstagramConnectorError("invalid_caption")
    return value


def _public_media_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) <= 32 for c in value):
        raise InstagramConnectorError("invalid_media_url")
    try:
        parts = urlsplit(value)
        host = parts.hostname or ""
        valid = (
            parts.scheme == "https"
            and bool(host)
            and parts.port in {None, 443}
            and not parts.username
            and not parts.password
            and not parts.fragment
            and not host.lower().rstrip(".").endswith((".local", ".internal", ".localhost"))
            and host.lower() != "localhost"
            and "." in host
            and "\\" not in value
        )
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            valid = False
    except ValueError:
        valid = False
    if not valid:
        raise InstagramConnectorError("invalid_media_url")
    return value


def _cursor(value: str | None) -> str | None:
    if value is not None and not _CURSOR.fullmatch(value):
        raise InstagramConnectorError("invalid_page")
    return value


def _limit(value: int) -> int:
    if type(value) is not int or not 1 <= value <= 50:
        raise InstagramConnectorError("invalid_page")
    return value


def _next_cursor(payload: dict[str, Any]) -> str | None:
    paging = payload.get("paging")
    cursors = paging.get("cursors") if isinstance(paging, dict) else None
    value = cursors.get("after") if isinstance(cursors, dict) else None
    return value if isinstance(value, str) and _CURSOR.fullmatch(value) else None


def _required_confirmation(confirmed: bool) -> None:
    if confirmed is not True:
        raise InstagramConnectorError("owner_confirmation_required", status_code=403)


def _mutation_id(result: dict[str, Any], field: str = "id", *, opaque: bool = False) -> str:
    """A malformed success response cannot prove whether a Graph write took effect."""
    try:
        return _id(result.get(field), opaque=opaque)
    except InstagramConnectorError:
        raise InstagramConnectorError("provider_outcome_unknown", status_code=502) from None


def _mutation_success(result: dict[str, Any]) -> None:
    if result.get("success") is not True:
        raise InstagramConnectorError("provider_outcome_unknown", status_code=502)


class ExternalConnectorInstagramCapabilities:
    """Use only fixed Graph paths and the current Instagram OAuth lifecycle."""

    def __init__(
        self,
        oauth: Any,
        *,
        claim_publish: Callable[[str, str, int, str], Awaitable[bool]] | None = None,
    ) -> None:
        self.oauth = oauth
        # Must atomically claim (owner, account, generation, container) once in
        # durable storage BEFORE Graph I/O. Never substitute a process lock.
        self.claim_publish = claim_publish

    async def _binding(self, *, user_id: str, scope: str) -> _Binding:
        row, credential = await self.oauth.current_credential(user_id=user_id)
        if scope not in (credential.get("grantedScopes") or ()):
            raise InstagramConnectorError("insufficient_scope", status_code=403)
        account_id = _id(credential.get("instagramUserId"))
        access_token = credential.get("accessToken")
        if not isinstance(access_token, str) or not access_token:
            raise InstagramConnectorError("reconnect_required", status_code=401)
        return _Binding(
            owner_id=user_id,
            account_id=account_id,
            generation=row["connection_generation"],
            version=row["credential_version"],
            access_token=access_token,
        )

    async def _fence(self, binding: _Binding) -> None:
        row = await self.oauth.lifecycle.read(
            user_id=binding.owner_id, connector_id="instagram", purge=False
        )
        if (
            not row
            or row["status"] != "connected"
            or row["connection_generation"] != binding.generation
            or row["credential_version"] != binding.version
            or row.get("validation_state") != "verified"
            or row.get("verified_policy_hash") != POLICY_HASH
        ):
            raise InstagramConnectorError("connection_changed", status_code=409)

    async def _get(
        self, binding: _Binding, path: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        await self._fence(binding)
        result = await self.oauth._graph_get(
            path, access_token=binding.access_token, params=params or {}
        )
        await self._fence(binding)
        return result

    async def _change(
        self,
        binding: _Binding,
        method: Literal["POST", "DELETE"],
        path: str,
        body: dict[str, Any] | None = None,
        *,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        await self._fence(binding)
        try:
            async with httpx.AsyncClient(
                timeout=15, follow_redirects=False, trust_env=False
            ) as client:
                async with client.stream(
                    method,
                    f"{GRAPH_BASE}/{path}",
                    params=params,
                    json=body if method == "POST" else None,
                    headers={
                        "Accept": "application/json",
                        "Authorization": f"Bearer {binding.access_token}",
                    },
                ) as response:
                    if 400 <= response.status_code < 500:
                        raise InstagramConnectorError("provider_rejected", status_code=502)
                    if response.status_code < 200 or response.status_code >= 300:
                        raise InstagramConnectorError("provider_outcome_unknown", status_code=502)
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > _MAX_RESPONSE_BYTES:
                            raise InstagramConnectorError(
                                "provider_outcome_unknown", status_code=502
                            )
        except httpx.HTTPError:
            # A failed transport after sending a write has an unknown outcome.
            # A caller must re-read provider state, never retry blindly.
            raise InstagramConnectorError("provider_outcome_unknown", status_code=502) from None
        try:
            result = json.loads(content)
        except (UnicodeDecodeError, ValueError):
            raise InstagramConnectorError("provider_outcome_unknown", status_code=502) from None
        if not isinstance(result, dict):
            raise InstagramConnectorError("provider_outcome_unknown", status_code=502)
        try:
            await self._fence(binding)
        except InstagramConnectorError:
            # A generation change after a Graph write cannot undo the write.
            raise InstagramConnectorError("provider_outcome_unknown", status_code=502) from None
        return result

    @staticmethod
    def _sign_container(binding: _Binding, container_id: str, kind: str) -> str:
        issued = int(datetime.now(UTC).timestamp())
        payload = {
            "id": _id(container_id),
            "kind": kind,
            "owner": hashlib.sha256(binding.owner_id.encode()).hexdigest(),
            "account": binding.account_id,
            "generation": binding.generation,
            "expires": issued + 23 * 3600,
        }
        encoded = (
            base64.urlsafe_b64encode(
                json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
            )
            .rstrip(b"=")
            .decode()
        )
        key = get_core_security_settings().app_signing_key.encode()
        signature = hmac.new(key, f"igc1.{encoded}".encode(), hashlib.sha256).hexdigest()
        return f"igc1.{encoded}.{signature}"

    @staticmethod
    def _open_container(binding: _Binding, handle: str) -> tuple[str, str]:
        if not isinstance(handle, str) or len(handle) > 1024:
            raise InstagramConnectorError("invalid_container")
        version, dot, rest = handle.partition(".")
        encoded, dot2, signature = rest.partition(".")
        if version != "igc1" or not dot or not dot2 or not _OPAQUE_ID.fullmatch(encoded):
            raise InstagramConnectorError("invalid_container")
        key = get_core_security_settings().app_signing_key.encode()
        expected = hmac.new(key, f"igc1.{encoded}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise InstagramConnectorError("invalid_container")
        try:
            payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        except (binascii.Error, ValueError, UnicodeDecodeError):
            raise InstagramConnectorError("invalid_container") from None
        if (
            not isinstance(payload, dict)
            or payload.get("owner") != hashlib.sha256(binding.owner_id.encode()).hexdigest()
            or payload.get("account") != binding.account_id
            or payload.get("generation") != binding.generation
            or payload.get("kind") not in _CONTAINER_KINDS
            or type(payload.get("expires")) is not int
            or payload["expires"] <= int(datetime.now(UTC).timestamp())
        ):
            raise InstagramConnectorError("invalid_container")
        return _id(payload.get("id")), payload["kind"]

    async def _container(
        self, binding: _Binding, kind: str, body: dict[str, Any]
    ) -> dict[str, str]:
        result = await self._change(binding, "POST", f"{binding.account_id}/media", body)
        container_id = _mutation_id(result)
        return {"containerHandle": self._sign_container(binding, container_id, kind), "kind": kind}

    async def publishing_limit(self, *, user_id: str) -> dict[str, int | None]:
        binding = await self._binding(user_id=user_id, scope=_PUBLISH_SCOPE)
        result = await self._get(binding, f"{binding.account_id}/content_publishing_limit")
        rows = result.get("data")
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
            raise InstagramConnectorError("provider_response_invalid", status_code=502)
        item = rows[0]
        config = item.get("config") if isinstance(item.get("config"), dict) else {}
        usage = item.get("quota_usage")
        if type(usage) is not int or usage < 0:
            raise InstagramConnectorError("provider_response_invalid", status_code=502)
        total = config.get("quota_total")
        duration = config.get("quota_duration")
        return {
            "used": usage,
            "total": total if type(total) is int and total > 0 else None,
            "durationSeconds": duration if type(duration) is int and duration > 0 else None,
        }

    async def create_photo_container(
        self,
        *,
        user_id: str,
        image_url: str,
        caption: str = "",
        alt_text: str | None = None,
        carousel_item: bool = False,
        is_ai_generated: bool = False,
        confirmed: bool,
    ) -> dict[str, str]:
        _required_confirmation(confirmed)
        caption = _caption(caption)
        if type(carousel_item) is not bool or type(is_ai_generated) is not bool:
            raise InstagramConnectorError("invalid_media_options")
        if caption and carousel_item:
            raise InstagramConnectorError("invalid_caption")
        if alt_text is not None and (
            not isinstance(alt_text, str)
            or len(alt_text) > 1000
            or any(ord(char) < 32 and char not in "\n\t" for char in alt_text)
        ):
            raise InstagramConnectorError("invalid_alt_text")
        if carousel_item and is_ai_generated:
            raise InstagramConnectorError("invalid_media_options")
        binding = await self._binding(user_id=user_id, scope=_PUBLISH_SCOPE)
        body: dict[str, Any] = {"image_url": _public_media_url(image_url)}
        if caption:
            body["caption"] = caption
        if alt_text:
            body["alt_text"] = alt_text
        if carousel_item:
            body["is_carousel_item"] = True
        if is_ai_generated:
            body["is_ai_generated"] = True
        return await self._container(binding, "photo_child" if carousel_item else "photo", body)

    async def create_reel_container(
        self,
        *,
        user_id: str,
        video_url: str,
        caption: str = "",
        share_to_feed: bool = True,
        is_ai_generated: bool = False,
        confirmed: bool,
    ) -> dict[str, str]:
        _required_confirmation(confirmed)
        caption = _caption(caption)
        if type(share_to_feed) is not bool or type(is_ai_generated) is not bool:
            raise InstagramConnectorError("invalid_media_options")
        binding = await self._binding(user_id=user_id, scope=_PUBLISH_SCOPE)
        body: dict[str, Any] = {
            "media_type": "REELS",
            "video_url": _public_media_url(video_url),
            "share_to_feed": share_to_feed,
        }
        if caption:
            body["caption"] = caption
        if is_ai_generated:
            body["is_ai_generated"] = True
        return await self._container(binding, "reel", body)

    async def create_video_carousel_item(
        self, *, user_id: str, video_url: str, confirmed: bool
    ) -> dict[str, str]:
        _required_confirmation(confirmed)
        binding = await self._binding(user_id=user_id, scope=_PUBLISH_SCOPE)
        return await self._container(
            binding,
            "video_child",
            {
                "media_type": "VIDEO",
                "video_url": _public_media_url(video_url),
                "is_carousel_item": True,
            },
        )

    async def create_story_image_container(
        self, *, user_id: str, image_url: str, confirmed: bool
    ) -> dict[str, str]:
        _required_confirmation(confirmed)
        binding = await self._binding(user_id=user_id, scope=_PUBLISH_SCOPE)
        return await self._container(
            binding,
            "story",
            {"media_type": "STORIES", "image_url": _public_media_url(image_url)},
        )

    async def create_story_video_container(
        self, *, user_id: str, video_url: str, confirmed: bool
    ) -> dict[str, str]:
        _required_confirmation(confirmed)
        binding = await self._binding(user_id=user_id, scope=_PUBLISH_SCOPE)
        return await self._container(
            binding,
            "story",
            {"media_type": "STORIES", "video_url": _public_media_url(video_url)},
        )

    async def create_carousel_container(
        self,
        *,
        user_id: str,
        children: list[str],
        caption: str = "",
        is_ai_generated: bool = False,
        confirmed: bool,
    ) -> dict[str, str]:
        _required_confirmation(confirmed)
        if not isinstance(children, list) or not 2 <= len(children) <= 10:
            raise InstagramConnectorError("invalid_carousel")
        caption = _caption(caption)
        if type(is_ai_generated) is not bool:
            raise InstagramConnectorError("invalid_media_options")
        binding = await self._binding(user_id=user_id, scope=_PUBLISH_SCOPE)
        resolved = [self._open_container(binding, handle) for handle in children]
        ids = [item_id for item_id, kind in resolved if kind in {"photo_child", "video_child"}]
        if len(ids) != len(children) or len(set(ids)) != len(ids):
            raise InstagramConnectorError("invalid_carousel")
        body: dict[str, Any] = {"media_type": "CAROUSEL", "children": ",".join(ids)}
        if caption:
            body["caption"] = caption
        if is_ai_generated:
            body["is_ai_generated"] = True
        return await self._container(binding, "carousel", body)

    async def container_status(self, *, user_id: str, handle: str) -> dict[str, str]:
        binding = await self._binding(user_id=user_id, scope=_PUBLISH_SCOPE)
        container_id, kind = self._open_container(binding, handle)
        result = await self._get(binding, container_id, {"fields": "id,status_code"})
        if result.get("id") != container_id or not isinstance(result.get("status_code"), str):
            raise InstagramConnectorError("provider_response_invalid", status_code=502)
        return {"kind": kind, "status": result["status_code"][:40]}

    async def publish_container(
        self, *, user_id: str, handle: str, confirmed: bool
    ) -> dict[str, str]:
        _required_confirmation(confirmed)
        binding = await self._binding(user_id=user_id, scope=_PUBLISH_SCOPE)
        container_id, kind = self._open_container(binding, handle)
        if kind not in {"photo", "reel", "carousel", "story"}:
            raise InstagramConnectorError("invalid_container")
        status = await self._get(binding, container_id, {"fields": "id,status_code"})
        if status.get("id") != container_id or status.get("status_code") != "FINISHED":
            raise InstagramConnectorError("container_not_ready", status_code=409)
        if self.claim_publish is None:
            raise InstagramConnectorError("publication_claim_unavailable", status_code=503)
        await self._fence(binding)
        try:
            claimed = await self.claim_publish(
                binding.owner_id, binding.account_id, binding.generation, container_id
            )
        except Exception:
            raise InstagramConnectorError(
                "publication_claim_unavailable", status_code=503
            ) from None
        if claimed is not True:
            raise InstagramConnectorError("publication_already_claimed", status_code=409)
        result = await self._change(
            binding, "POST", f"{binding.account_id}/media_publish", {"creation_id": container_id}
        )
        return {"mediaId": _mutation_id(result)}

    async def _owned_media(self, binding: _Binding, media_id: str) -> str:
        media_id = _id(media_id)
        result = await self._get(binding, media_id, {"fields": "id,owner"})
        owner = result.get("owner")
        if (
            result.get("id") != media_id
            or not isinstance(owner, dict)
            or owner.get("id") != binding.account_id
        ):
            raise InstagramConnectorError("media_not_owned", status_code=403)
        return media_id

    async def _owned_comment(self, binding: _Binding, comment_id: str) -> str:
        comment_id = _id(comment_id)
        comment = await self._get(binding, comment_id, {"fields": "id,media"})
        media = comment.get("media")
        if comment.get("id") != comment_id or not isinstance(media, dict):
            raise InstagramConnectorError("comment_not_owned", status_code=403)
        await self._owned_media(binding, media.get("id"))
        return comment_id

    async def list_comments(
        self, *, user_id: str, media_id: str, limit: int = 25, after: str | None = None
    ) -> dict[str, Any]:
        binding = await self._binding(user_id=user_id, scope=_COMMENTS_SCOPE)
        media_id = await self._owned_media(binding, media_id)
        params: dict[str, Any] = {
            "fields": "id,text,timestamp,username,hidden",
            "limit": _limit(limit),
        }
        if _cursor(after):
            params["after"] = after
        result = await self._get(binding, f"{media_id}/comments", params)
        rows = result.get("data")
        if not isinstance(rows, list) or len(rows) > limit:
            raise InstagramConnectorError("provider_response_invalid", status_code=502)
        comments = []
        for row in rows:
            if not isinstance(row, dict):
                raise InstagramConnectorError("provider_response_invalid", status_code=502)
            comments.append(
                {
                    "id": _id(row.get("id")),
                    "text": str(row.get("text") or "")[:2200],
                    "timestamp": str(row.get("timestamp") or "")[:64],
                    "username": str(row.get("username") or "")[:100],
                    "hidden": row.get("hidden") is True,
                }
            )
        return {"comments": comments, "nextCursor": _next_cursor(result)}

    async def reply_to_comment(
        self, *, user_id: str, comment_id: str, message: str, confirmed: bool
    ) -> dict[str, str]:
        _required_confirmation(confirmed)
        message = _text(message, maximum=2200, label="comment")
        binding = await self._binding(user_id=user_id, scope=_COMMENTS_SCOPE)
        comment_id = await self._owned_comment(binding, comment_id)
        result = await self._change(binding, "POST", f"{comment_id}/replies", {"message": message})
        return {"commentId": _mutation_id(result)}

    async def set_comment_hidden(
        self, *, user_id: str, comment_id: str, hidden: bool, confirmed: bool
    ) -> dict[str, bool]:
        _required_confirmation(confirmed)
        if type(hidden) is not bool:
            raise InstagramConnectorError("invalid_moderation")
        binding = await self._binding(user_id=user_id, scope=_COMMENTS_SCOPE)
        comment_id = await self._owned_comment(binding, comment_id)
        result = await self._change(
            binding, "POST", comment_id, params={"hide": str(hidden).lower()}
        )
        _mutation_success(result)
        return {"hidden": hidden}

    async def delete_comment(
        self, *, user_id: str, comment_id: str, confirmed: bool
    ) -> dict[str, bool]:
        _required_confirmation(confirmed)
        binding = await self._binding(user_id=user_id, scope=_COMMENTS_SCOPE)
        comment_id = await self._owned_comment(binding, comment_id)
        result = await self._change(binding, "DELETE", comment_id)
        _mutation_success(result)
        return {"deleted": True}

    @staticmethod
    def _insight_value(result: dict[str, Any], metric: str) -> dict[str, Any]:
        rows = result.get("data")
        if not isinstance(rows, list) or len(rows) > 1:
            raise InstagramConnectorError("provider_response_invalid", status_code=502)
        if not rows:
            return {"metric": metric, "available": False, "value": None}
        row = rows[0]
        if not isinstance(row, dict) or row.get("name") != metric:
            raise InstagramConnectorError("provider_response_invalid", status_code=502)
        total = row.get("total_value")
        values = row.get("values")
        value = total.get("value") if isinstance(total, dict) else None
        if (
            value is None
            and isinstance(values, list)
            and len(values) == 1
            and isinstance(values[0], dict)
        ):
            value = values[0].get("value")
        if (
            type(value) not in {int, float}
            or value < 0
            or (type(value) is float and not math.isfinite(value))
        ):
            raise InstagramConnectorError("provider_response_invalid", status_code=502)
        return {"metric": metric, "available": True, "value": value}

    async def account_insight(self, *, user_id: str, metric: str) -> dict[str, Any]:
        if metric not in _ACCOUNT_METRICS:
            raise InstagramConnectorError("invalid_insight_metric")
        binding = await self._binding(user_id=user_id, scope=_INSIGHTS_SCOPE)
        result = await self._get(
            binding,
            f"{binding.account_id}/insights",
            {"metric": metric, "period": "day", "metric_type": "total_value"},
        )
        return self._insight_value(result, metric)

    async def media_insight(self, *, user_id: str, media_id: str, metric: str) -> dict[str, Any]:
        if metric not in _MEDIA_METRICS:
            raise InstagramConnectorError("invalid_insight_metric")
        binding = await self._binding(user_id=user_id, scope=_INSIGHTS_SCOPE)
        media_id = await self._owned_media(binding, media_id)
        result = await self._get(binding, f"{media_id}/insights", {"metric": metric})
        return self._insight_value(result, metric)

    async def tagged_media(
        self, *, user_id: str, limit: int = 25, after: str | None = None
    ) -> dict[str, Any]:
        # This is tagged media, not a search for arbitrary caption @mentions.
        binding = await self._binding(user_id=user_id, scope=_COMMENTS_SCOPE)
        params: dict[str, Any] = {
            "fields": "id,username,permalink,timestamp",
            "limit": _limit(limit),
        }
        if _cursor(after):
            params["after"] = after
        result = await self._get(binding, f"{binding.account_id}/tags", params)
        rows = result.get("data")
        if not isinstance(rows, list) or len(rows) > limit:
            raise InstagramConnectorError("provider_response_invalid", status_code=502)
        media = []
        for row in rows:
            if not isinstance(row, dict):
                raise InstagramConnectorError("provider_response_invalid", status_code=502)
            permalink = str(row.get("permalink") or "")
            parts = urlsplit(permalink)
            if parts.scheme != "https" or parts.hostname not in {
                "instagram.com",
                "www.instagram.com",
            }:
                raise InstagramConnectorError("provider_response_invalid", status_code=502)
            media.append(
                {
                    "id": _id(row.get("id")),
                    "username": str(row.get("username") or "")[:100],
                    "permalink": permalink,
                    "timestamp": str(row.get("timestamp") or "")[:64],
                }
            )
        return {"media": media, "nextCursor": _next_cursor(result)}

    async def _conversation(self, binding: _Binding, recipient_id: str) -> str:
        recipient_id = _id(recipient_id)
        result = await self._get(
            binding,
            f"{binding.account_id}/conversations",
            {"user_id": recipient_id},
        )
        rows = result.get("data")
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
            raise InstagramConnectorError("conversation_unavailable", status_code=403)
        return _id(rows[0].get("id"), opaque=True)

    async def recent_messages(self, *, user_id: str, recipient_id: str) -> dict[str, Any]:
        binding = await self._binding(user_id=user_id, scope=_MESSAGES_SCOPE)
        conversation_id = await self._conversation(binding, recipient_id)
        result = await self._get(binding, conversation_id, {"fields": "messages"})
        messages = result.get("messages")
        rows = messages.get("data") if isinstance(messages, dict) else None
        if result.get("id") != conversation_id or not isinstance(rows, list):
            raise InstagramConnectorError("provider_response_invalid", status_code=502)
        output = []
        for row in rows[:20]:
            if not isinstance(row, dict):
                raise InstagramConnectorError("provider_response_invalid", status_code=502)
            message_id = _id(row.get("id"), opaque=True)
            detail = await self._get(
                binding, message_id, {"fields": "id,created_time,from,to,message"}
            )
            if detail.get("id") != message_id or not isinstance(detail.get("from"), dict):
                raise InstagramConnectorError("provider_response_invalid", status_code=502)
            sender = _id(detail["from"].get("id"))
            if sender not in {binding.account_id, recipient_id}:
                raise InstagramConnectorError("provider_response_invalid", status_code=502)
            to = detail.get("to")
            recipients = to.get("data") if isinstance(to, dict) else None
            expected_recipient = binding.account_id if sender == recipient_id else recipient_id
            if (
                not isinstance(recipients, list)
                or len(recipients) != 1
                or not isinstance(recipients[0], dict)
                or recipients[0].get("id") != expected_recipient
            ):
                raise InstagramConnectorError("provider_response_invalid", status_code=502)
            output.append(
                {
                    "id": message_id,
                    "senderId": sender,
                    "createdTime": str(detail.get("created_time") or "")[:64],
                    "text": str(detail.get("message") or "")[:1000],
                }
            )
        return {"messages": output}

    async def send_text_message(
        self, *, user_id: str, recipient_id: str, message: str, confirmed: bool
    ) -> dict[str, str]:
        _required_confirmation(confirmed)
        recipient_id = _id(recipient_id)
        message = _text(message, maximum=1000, label="message")
        if len(message.encode("utf-8")) > 1000:
            raise InstagramConnectorError("invalid_message")
        binding = await self._binding(user_id=user_id, scope=_MESSAGES_SCOPE)
        # Meta permits a standard reply only within 24 hours of a person's
        # inbound message. Confirm it from provider state, not a caller claim.
        recent = await self.recent_messages(user_id=user_id, recipient_id=recipient_id)
        cutoff = datetime.now(UTC) - timedelta(hours=24)
        allowed = False
        for item in recent["messages"]:
            if item["senderId"] != recipient_id:
                continue
            try:
                sent = datetime.fromisoformat(item["createdTime"].replace("Z", "+00:00"))
            except ValueError:
                continue
            if sent.tzinfo is not None and cutoff <= sent <= datetime.now(UTC):
                allowed = True
                break
        if not allowed:
            raise InstagramConnectorError("message_window_closed", status_code=403)
        result = await self._change(
            binding,
            "POST",
            f"{binding.account_id}/messages",
            {"recipient": {"id": recipient_id}, "message": {"text": message}},
        )
        if result.get("recipient_id") != recipient_id:
            raise InstagramConnectorError("provider_outcome_unknown", status_code=502)
        return {"messageId": _mutation_id(result, "message_id", opaque=True)}

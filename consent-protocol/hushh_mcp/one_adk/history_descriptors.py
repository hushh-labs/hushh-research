"""Pure restoration of authored One cards and conversation titles, across runtimes."""

from __future__ import annotations

import hashlib
import re
import uuid
from typing import Any

from hushh_mcp.one_adk.history_projection import (
    _bounded_text,
    _record,
    _safe_workspace_connector_setup_descriptor,
)
from hushh_mcp.one_adk.shared_with_me_card import (
    SHARED_WITH_ME_CARD_KIND,
    project_shared_with_me_card,
)


def _event_text(event: Any) -> str:
    from hushh_mcp.one_adk.output_privacy import public_text

    return public_text(event)


_SAFE_PROFILE_PATH = re.compile(r"^/people/[A-Za-z0-9_-]{16,128}$")


def _safe_scope_catalog(value: Any, *, scope_count: int) -> dict[str, Any] | None:
    """Keep only bounded pagination metadata on a restored discovery card.

    The encrypted session descriptor must not become a second scope authority:
    the current page remains the only place where requestable field metadata is
    projected. These fields only let the client ask the server for the next
    page, and the server rechecks the catalog revision and current authority.
    """
    catalog = _record(value)
    if not catalog:
        return None

    def bounded_integer(raw: Any, *, minimum: int, maximum: int | None = None) -> int | None:
        if isinstance(raw, bool) or not isinstance(raw, int) or raw < minimum:
            return None
        if maximum is not None and raw > maximum:
            return None
        return int(raw)

    page = bounded_integer(catalog.get("page"), minimum=1)
    limit = bounded_integer(catalog.get("limit"), minimum=1, maximum=100)
    total_count = bounded_integer(catalog.get("totalCount"), minimum=0)
    revision = _bounded_text(catalog.get("catalogRevision"), 64)
    has_more = catalog.get("hasMore")
    next_page = catalog.get("nextPage")
    if (
        page is None
        or limit is None
        or total_count is None
        or total_count < scope_count
        or not revision
        or not re.fullmatch(r"[a-f0-9]{64}", revision)
        or not isinstance(has_more, bool)
    ):
        return None

    if has_more:
        if next_page != page + 1:
            return None
    elif next_page is not None:
        return None

    domains: list[dict[str, Any]] = []
    raw_domains = catalog.get("domains")
    if isinstance(raw_domains, list):
        for raw_domain in raw_domains[:128]:
            domain = _record(raw_domain)
            name = _bounded_text(domain.get("domain") if domain else None, 80)
            count = bounded_integer(domain.get("count") if domain else None, minimum=0)
            if name and count is not None:
                domains.append({"domain": name, "count": count})

    return {
        "page": page,
        "nextPage": next_page if has_more else None,
        "totalCount": total_count,
        "limit": limit,
        "hasMore": has_more,
        "catalogRevision": revision,
        "paginationReset": catalog.get("paginationReset") is True,
        "domains": domains,
    }


def _safe_discovery_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    """Project one display-safe discovery card out of an encrypted event.

    The session remains encrypted at rest. This projection is deliberately
    narrower than the tool result: it carries no personal values, email
    addresses, credentials, or executable action payloads. It exists so a
    returning owner can see the same AG-UI card without replaying the action.
    """
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        function_response = getattr(part, "function_response", None)
        if (
            function_response is None
            or getattr(function_response, "name", "") != "discover_person_information"
        ):
            continue
        result = _record(getattr(function_response, "response", None)) or {}
        for key in ("result", "content", "data"):
            nested = _record(result.get(key))
            if nested and (nested.get("status") == "ok" or "requestableScopes" in nested):
                result = nested
                break
        if result.get("status") != "ok":
            return None
        person = _record(result.get("person")) or {}
        display_name = _bounded_text(person.get("displayName"), 120)
        profile_path = _bounded_text(person.get("profilePath"), 180)
        if not display_name or not profile_path or not _SAFE_PROFILE_PATH.fullmatch(profile_path):
            return None
        profile_person_ref = profile_path.rsplit("/", 1)[-1]
        person_ref = _bounded_text(person.get("personRef"), 128)
        if person_ref and (
            not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", person_ref)
            or person_ref != profile_person_ref
        ):
            return None
        scopes: list[dict[str, Any]] = []
        raw_scopes = result.get("requestableScopes")
        if isinstance(raw_scopes, list):
            for raw_scope in raw_scopes[:250]:
                scope = _record(raw_scope)
                if scope is None:
                    continue
                scope_ref = _bounded_text(scope.get("scopeRef"), 180)
                label = _bounded_text(scope.get("label"), 120)
                domain = _bounded_text(scope.get("domain"), 80)
                if not scope_ref or not label or not domain:
                    continue
                sensitivity = _bounded_text(scope.get("sensitivity"), 32)
                scopes.append(
                    {
                        "scopeRef": scope_ref,
                        "label": label,
                        "description": _bounded_text(scope.get("description"), 280),
                        "domain": domain,
                        "sensitivity": sensitivity or "standard",
                        "pathSegments": [
                            value
                            for part in (scope.get("pathSegments") or [])[:32]
                            if (value := _bounded_text(part, 120))
                        ]
                        if isinstance(scope.get("pathSegments"), list)
                        else [],
                    }
                )
        scope_catalog = _safe_scope_catalog(result.get("scopeCatalog"), scope_count=len(scopes))
        return {
            "activityType": "one.scope_discovery.v1",
            "content": {
                "status": "ok",
                "person": {
                    "displayName": display_name,
                    "profilePath": profile_path,
                    **({"personRef": person_ref} if person_ref else {}),
                    "relationship": _bounded_text(person.get("relationship"), 64),
                },
                "domainFilter": _bounded_text(result.get("domainFilter"), 80),
                "requestableScopes": scopes,
                **({"scopeCatalog": scope_catalog} if scope_catalog is not None else {}),
                "catalogIncomplete": (
                    (scope_catalog is not None and scope_catalog["hasMore"])
                    or (isinstance(raw_scopes, list) and len(raw_scopes) > 250)
                ),
            },
        }
    return None


def _safe_information_request_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    """Project a proposal review card without retaining executable handles.

    A returning owner may see what they were preparing to ask, but a history
    descriptor must never become a replayable consent mutation. The proposal
    id, opaque scope references, connector metadata, and any values therefore
    stay in the encrypted session only; the restored card is explanatory.
    """
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        function_response = getattr(part, "function_response", None)
        if (
            function_response is None
            or getattr(function_response, "name", "") != "propose_information_request"
        ):
            continue
        result = _record(getattr(function_response, "response", None)) or {}
        for key in ("result", "content", "data"):
            nested = _record(result.get(key))
            if nested and nested.get("status"):
                result = nested
                break
        if result.get("status") != "proposal_ready":
            return None
        person = _record(result.get("person")) or {}
        display_name = _bounded_text(person.get("displayName"), 120)
        subject_ref = _bounded_text(person.get("personRef"), 128)
        if subject_ref and not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", subject_ref):
            subject_ref = None
        purpose = _bounded_text(result.get("purpose"), 500)
        duration_hours = result.get("durationHours")
        if (
            not display_name
            or not purpose
            or isinstance(duration_hours, bool)
            or not isinstance(duration_hours, int)
            or not 1 <= duration_hours <= 720
        ):
            return None
        raw_fields = result.get("fields")
        if not isinstance(raw_fields, list):
            return None
        fields = [
            {
                "label": label,
                "domain": "Information",
                "sensitivity": "standard",
            }
            for raw_field in raw_fields[:50]
            if (label := _bounded_text(raw_field, 120))
        ]
        if not fields:
            return None
        duration_label = (
            f"{duration_hours // 24} {'day' if duration_hours // 24 == 1 else 'days'}"
            if duration_hours % 24 == 0
            else f"{duration_hours} {'hour' if duration_hours == 1 else 'hours'}"
        )
        content = {
            "direction": "outgoing",
            "phase": "draft",
            "status": "awaiting_review",
            "personName": display_name,
            "purpose": purpose,
            "durationLabel": duration_label,
            "fields": fields,
        }
        if subject_ref:
            content["subjectRef"] = subject_ref
        return {
            "activityType": "one.information_request_review.v1",
            "content": content,
        }
    return None


def _safe_shared_with_me_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    """Restore the "Shared with you" card (CONTRACT-2 C6) from its sealed tool result.

    The card carries labels, field names, dates and the refs the device opens
    each item by; it never carried a value. Each card is re-validated field by
    field, so a stored result cannot smuggle anything else into history.
    """
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        function_response = getattr(part, "function_response", None)
        if (
            function_response is None
            or getattr(function_response, "name", "") != "list_information_shared_with_me"
        ):
            continue
        result = _record(getattr(function_response, "response", None)) or {}
        for key in ("result", "content", "data"):
            nested = _record(result.get(key))
            if nested and nested.get("status"):
                result = nested
                break
        raw_cards = result.get("cards")
        if result.get("status") != "ok" or not isinstance(raw_cards, list):
            return None
        cards = [
            card
            for raw in raw_cards[:20]
            if (card := project_shared_with_me_card(_record(raw))) is not None
        ]
        if not cards:
            return None
        return {"activityType": SHARED_WITH_ME_CARD_KIND, "content": {"cards": cards}}
    return None


def _safe_proposal_source(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    """The recipient of One's ask card (``propose_information_request``), or None.

    The ask card is a send surface exactly like a discovery card, so its receipt
    is bound the same way: a sealed ``proposal_ready`` result in this
    conversation that carries a proposal, and a person whose reference matches
    their profile path. Nothing else of the proposal leaves the session.
    """
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        function_response = getattr(part, "function_response", None)
        if (
            function_response is None
            or getattr(function_response, "name", "") != "propose_information_request"
        ):
            continue
        result = _record(getattr(function_response, "response", None)) or {}
        for key in ("result", "content", "data"):
            nested = _record(result.get(key))
            if nested and nested.get("status"):
                result = nested
                break
        proposed = result.get("proposed")
        if result.get("status") != "proposal_ready" or not isinstance(proposed, list):
            return None
        if not any(_record(item) for item in proposed):
            return None
        person = _record(result.get("person")) or {}
        display_name = _bounded_text(person.get("displayName"), 120)
        profile_path = _bounded_text(person.get("profilePath"), 180)
        person_ref = _bounded_text(person.get("personRef"), 128)
        if (
            not display_name
            or not profile_path
            or not person_ref
            or not _SAFE_PROFILE_PATH.fullmatch(profile_path)
            or profile_path.rsplit("/", 1)[-1] != person_ref
        ):
            return None
        return {
            "person": {
                "displayName": display_name,
                "profilePath": profile_path,
                "personRef": person_ref,
            }
        }
    return None


def _safe_submitted_information_request_card(card: Any) -> dict[str, Any] | None:
    """Allowlist display-only submission metadata, never consent authority."""
    card = _record(card) or {}
    if (
        card.get("activityType") != "one.information_request_review.v1"
        or card.get("direction") != "outgoing"
        or card.get("phase") != "submitted"
    ):
        return None
    person_name = _bounded_text(card.get("personName"), 120)
    purpose = _bounded_text(card.get("purpose"), 500)
    duration_label = _bounded_text(card.get("durationLabel"), 100)
    status = _bounded_text(card.get("status"), 32)
    if (
        not person_name
        or not purpose
        or not duration_label
        or status
        not in {"pending", "mixed", "cancelled", "granted", "denied", "expired", "revoked"}
    ):
        return None
    raw_fields = card.get("fields")
    if not isinstance(raw_fields, list):
        return None
    fields: list[dict[str, Any]] = []
    for raw_field in raw_fields[:50]:
        field = _record(raw_field)
        if not field:
            continue
        label = _bounded_text(field.get("label"), 120)
        domain = _bounded_text(field.get("domain"), 80)
        if not label or not domain:
            continue
        projected = {
            "label": label,
            "domain": domain,
            "sensitivity": _bounded_text(field.get("sensitivity"), 32) or "standard",
        }
        request_id = _bounded_text(field.get("requestId"), 128)
        if request_id and re.fullmatch(r"[A-Za-z0-9_-]{8,128}", request_id):
            projected["requestId"] = request_id
        field_status = _bounded_text(field.get("status"), 32)
        if field_status in {"pending", "cancelled", "granted", "denied", "expired", "revoked"}:
            projected["status"] = field_status
        fields.append(projected)
    if not fields:
        return None
    content: dict[str, Any] = {
        "direction": "outgoing",
        "phase": "submitted",
        "status": status,
        "personName": person_name,
        "purpose": purpose,
        "durationLabel": duration_label,
        "fields": fields,
    }
    for key, pattern in (
        ("subjectRef", r"^[A-Za-z0-9_-]{16,128}$"),
        ("bundleId", r"^[A-Za-z0-9_-]{8,128}$"),
        ("requestId", r"^[A-Za-z0-9_-]{8,128}$"),
    ):
        value = _bounded_text(card.get(key), 128)
        if value and re.fullmatch(pattern, value):
            content[key] = value
    return {"activityType": "one.information_request_review.v1", "content": content}


def _safe_document_request_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        response = getattr(part, "function_response", None)
        if response is None or getattr(response, "name", "") != "propose_document_request":
            continue
        result = _record(getattr(response, "response", None)) or {}
        for key in ("result", "content", "data"):
            nested = _record(result.get(key))
            if nested and nested.get("status"):
                result = nested
                break
        if result.get("status") != "proposal_ready":
            return None
        person = _record(result.get("person")) or {}
        purpose = _record(result.get("purpose")) or {}
        person_ref = _bounded_text(person.get("personRef"), 36)
        client_id = _bounded_text(result.get("clientRequestId"), 36)
        person_name = _bounded_text(person.get("displayName"), 120)
        purpose_text = _bounded_text(purpose.get("purpose"), 2000)
        if (
            not person_ref
            or not client_id
            or not person_name
            or not purpose_text
            or not re.fullmatch(r"[0-9a-f-]{36}", person_ref)
            or not re.fullmatch(r"[0-9a-f-]{36}", client_id)
        ):
            return None
        start = purpose.get("periodStart")
        end = purpose.get("periodEnd")
        if (start is None) != (end is None):
            return None
        if start is not None and (
            not isinstance(start, str)
            or not isinstance(end, str)
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", start)
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end)
        ):
            return None
        return {
            "activityType": "one.document_request_review.v1",
            "content": {
                "personRef": person_ref,
                "personName": person_name,
                "clientRequestId": client_id,
                "purpose": purpose_text,
                "periodStart": start,
                "periodEnd": end,
            },
        }
    return None


def _safe_drive_share_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    """Restore the owner's Drive share card: a person and the files in words.

    It carries no file id and grants nothing; the card searches and shares
    only after the owner's own taps, through the owner-authenticated routes.
    """
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        response = getattr(part, "function_response", None)
        if response is None or getattr(response, "name", "") != "propose_drive_share":
            continue
        result = _record(getattr(response, "response", None)) or {}
        for key in ("result", "content", "data"):
            nested = _record(result.get(key))
            if nested and nested.get("status"):
                result = nested
                break
        if result.get("status") != "proposal_ready":
            return None
        client_id = _bounded_text(result.get("clientRequestId"), 36)
        files_request = _bounded_text(result.get("filesRequest"), 2000)
        if result.get("audience") == "trusted_circle":
            if not client_id or not files_request or not re.fullmatch(r"[0-9a-f-]{36}", client_id):
                return None
            return {
                "activityType": "one.drive_share_review.v1",
                "content": {
                    "audience": "trusted_circle",
                    "clientRequestId": client_id,
                    "filesRequest": files_request,
                },
            }
        person = _record(result.get("person")) or {}
        person_ref = _bounded_text(person.get("personRef"), 36)
        person_name = _bounded_text(person.get("displayName"), 120)
        if (
            not person_ref
            or not client_id
            or not person_name
            or not files_request
            or not re.fullmatch(r"[0-9a-f-]{36}", person_ref)
            or not re.fullmatch(r"[0-9a-f-]{36}", client_id)
        ):
            return None
        return {
            "activityType": "one.drive_share_review.v1",
            "content": {
                "personRef": person_ref,
                "personName": person_name,
                "clientRequestId": client_id,
                "filesRequest": files_request,
            },
        }
    return None


def _safe_submitted_information_request_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    """Restore existing app-action settlements without replaying their authority."""
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        response = getattr(part, "function_response", None)
        if response is None or response.name != "run_app_action":
            continue
        result = _record(response.response) or {}
        if result.get("status") != "succeeded":
            continue
        data = _record(result.get("data")) or {}
        descriptor = _safe_submitted_information_request_card(data.get("consentCard"))
        if descriptor:
            return descriptor
    return None


def _safe_agent_history_metadata(
    event: Any,
    suppressed_discovery_ids: set[str] | None = None,
    call_providers: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    descriptors = []
    seen = set()
    presentation = _record(getattr(event, "custom_metadata", None)) or {}
    if presentation.get("kind") == "information_request_submission_v1":
        if _submitted_source_id(event) is None:
            return None
        descriptor = _safe_submitted_information_request_card(presentation.get("card"))
        return (
            {
                "kind": "structured_experience",
                "structuredExperiences": [{"id": event.id, **descriptor}],
                "structuredExperience": descriptor,
                "structuredExperienceId": event.id,
            }
            if descriptor
            else None
        )
    event_identity = (
        _bounded_text(getattr(event, "id", None), 128)
        or _bounded_text(getattr(event, "invocation_id", None), 128)
        or "event"
    )
    for index, part in enumerate(getattr(getattr(event, "content", None), "parts", None) or []):
        descriptor = _safe_discovery_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_submitted_information_request_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_information_request_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_shared_with_me_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_document_request_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_drive_share_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_drive_bulk_share_descriptor(event, [part])
        if descriptor is None:
            descriptor = _safe_workspace_connector_setup_descriptor(event, [part], call_providers)
        if descriptor is None:
            continue
        invocation_identity = _bounded_text(
            getattr(getattr(part, "function_response", None), "id", None), 128
        )
        card_id = f"{event_identity}:{invocation_identity or index}"
        if card_id in (suppressed_discovery_ids or set()) and (
            _safe_discovery_descriptor(event, [part]) or _safe_proposal_source(event, [part])
        ):
            continue
        if card_id in seen:
            continue
        seen.add(card_id)
        descriptors.append({"id": card_id, **descriptor})
    if not descriptors:
        return None
    return {
        "kind": "structured_experience",
        "structuredExperiences": descriptors,
        "structuredExperience": {
            key: value for key, value in descriptors[0].items() if key != "id"
        },
        "structuredExperienceId": str(getattr(event, "id", "") or "").strip() or None,
    }


def _session_title(session: Any) -> str:
    authored = str((session.state or {}).get("hussh:thread_title") or "").strip()
    if authored:
        return authored
    for event in session.events:
        if event.author == "user":
            text = _event_text(event)
            if text:
                return text[:80]
    return "New conversation"


def _request_source(session: Any, activity_id: str) -> tuple[str, dict[str, Any]] | None:
    """Find this conversation's unique discovery or information-request proposal card."""
    matches: list[tuple[str, dict[str, Any]]] = []
    for event in session.events:
        event_id = (
            _bounded_text(getattr(event, "id", None), 128)
            or _bounded_text(getattr(event, "invocation_id", None), 128)
            or "event"
        )
        for index, part in enumerate(getattr(getattr(event, "content", None), "parts", None) or []):
            discovery = _safe_discovery_descriptor(event, [part])
            source = discovery["content"] if discovery else _safe_proposal_source(event, [part])
            if source is None:
                continue
            tool_id = _bounded_text(
                getattr(getattr(part, "function_response", None), "id", None), 128
            )
            card_id = f"{event_id}:{tool_id or index}"
            if activity_id in {card_id, tool_id}:
                matches.append((card_id, source))
    return matches[0] if len(matches) == 1 else None


# Existing route/tests imported the narrower name before ask cards were supported.
_discovery_source = _request_source


def _submitted_source_id(event: Any) -> str | None:
    presentation = _record(getattr(event, "custom_metadata", None)) or {}
    if presentation.get("kind") != "information_request_submission_v1" or event.content is not None:
        return None
    if _safe_submitted_information_request_card(presentation.get("card")) is None:
        return None
    source_id = _bounded_text(presentation.get("sourceCardId"), 256)
    expected_id = f"request_submission_{hashlib.sha256(str(source_id).encode()).hexdigest()[:32]}"
    return source_id if source_id and event.id == expected_id else None


def _safe_drive_bulk_share_descriptor(
    event: Any, selected_parts: list[Any] | None = None
) -> dict[str, Any] | None:
    """Restore a review-only saved-search proposal without private file metadata."""
    parts = (
        selected_parts
        if selected_parts is not None
        else (getattr(getattr(event, "content", None), "parts", None) or [])
    )
    for part in parts:
        response = getattr(part, "function_response", None)
        if response is None or getattr(response, "name", "") != "propose_drive_bulk_share":
            continue
        result = _record(getattr(response, "response", None)) or {}
        for key in ("result", "content", "data"):
            nested = _record(result.get(key))
            if nested and nested.get("status"):
                result = nested
                break
        if result.get("status") != "proposal_ready" or result.get("audience") != "trusted_circle":
            return None
        try:
            search_job_id = str(uuid.UUID(str(result.get("searchJobId"))))
            client_request_id = str(uuid.UUID(str(result.get("clientRequestId"))))
        except (ValueError, TypeError, AttributeError):
            return None
        return {
            "activityType": "one.drive_bulk_share_review.v1",
            "content": {
                "audience": "trusted_circle",
                "searchJobId": search_job_id,
                "clientRequestId": client_request_id,
            },
        }
    return None

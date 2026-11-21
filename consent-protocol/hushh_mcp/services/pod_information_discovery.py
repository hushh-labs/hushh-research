"""Metadata adapters for the existing person resolver and request proposal in owner pods."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictStr

_DISCOVERY_OPERATIONS = Literal[
    "connections",
    "directory",
    "catalog",
    "pending",
    "granted_shares",
    "pending_incoming",
    "active_grants",
    "outgoing_requests",
    "connection_requests",
]


class InformationDiscoveryOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: _DISCOVERY_OPERATIONS
    person_ref: str = Field(default="", max_length=128)
    query: str = Field(default="", max_length=160)
    page: int = Field(default=1, ge=1, le=250)
    limit: int = Field(default=100, ge=1, le=100)
    scope_refs: list[str] = Field(default_factory=list, max_length=50)


class DirectoryPerson(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    displayName: str = Field(max_length=256)
    publicPersonRef: str | None = Field(default=None, max_length=128)
    email: str | None = Field(default=None, max_length=320)


class RequestableItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scopeRef: str = Field(min_length=1, max_length=200)
    label: str = Field(max_length=256)
    description: str | None = Field(default=None, max_length=2000)
    domain: str | None = Field(default=None, max_length=128)
    domainLabel: str = Field(max_length=256)
    iconName: str | None = Field(default=None, max_length=64)
    sensitivity: Literal["sensitive", "standard"]
    wildcard: StrictBool
    pathSegments: list[str] = Field(max_length=100)


class RequestableCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    personRef: str = Field(min_length=1, max_length=128)
    requestableScopes: list[RequestableItem] = Field(max_length=2000)
    connectorReady: StrictBool


class PendingInformationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    bundleId: str = Field(min_length=36, max_length=36)
    purpose: str | None = Field(default=None, max_length=2000)
    durationSeconds: int = Field(ge=1, le=7_776_000)
    sentAt: str | None = Field(default=None, max_length=64)
    scopeRefs: list[str] = Field(max_length=50)
    labels: list[str] = Field(max_length=50)


class GrantedShareField(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=80)
    sensitivity: Literal["sensitive", "standard"] = "sensitive"


class GrantedShareItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    personRef: str = Field(min_length=1, max_length=128)
    person: str | None = Field(default=None, max_length=256)
    grantRef: str = Field(min_length=1, max_length=128)
    requestId: str = Field(min_length=1, max_length=128)
    bundleId: str | None = Field(default=None, max_length=64)
    scopeRef: str | None = Field(default=None, max_length=200)
    iconName: str | None = Field(default=None, max_length=64)
    label: str = Field(min_length=1, max_length=256)
    sensitivity: Literal["sensitive", "standard"] = "sensitive"
    fieldOutline: list[str] = Field(default_factory=list, max_length=20)
    fields: list[GrantedShareField] = Field(default_factory=list, max_length=20)
    sharedAt: str | None = Field(default=None, max_length=64)
    accessEndsAt: str | None = Field(default=None, max_length=64)
    purpose: str | None = Field(default=None, max_length=500)
    decryptable: StrictBool = True


class PendingIncomingRequestItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    requestId: str = Field(default="", max_length=200)
    requestIds: list[str] = Field(default_factory=list, max_length=50)
    requesterLabel: str = Field(default="Someone", max_length=256)
    requesterType: str = Field(default="unknown", max_length=64)
    description: str = Field(default="some of your information", max_length=2000)
    reason: str | None = Field(default=None, max_length=2000)
    bundleLabel: str | None = Field(default=None, max_length=256)
    bundleScopeCount: int | None = Field(default=None, ge=0, le=500)
    issuedAt: int | str | None = None
    expiresAt: int | str | None = None


class ActiveGrantDiscoveryItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    scope: str = Field(min_length=1, max_length=200)
    requestId: str | None = Field(default=None, max_length=200)
    label: str = Field(min_length=1, max_length=256)
    holderLabel: str = Field(min_length=1, max_length=256)
    issuedAt: int | str | None = None
    expiresAt: int | str | None = None


class OutgoingInformationRequestItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    bundleId: str = Field(min_length=1, max_length=64)
    personRef: str = Field(default="", max_length=128)
    displayName: str = Field(default="that person", max_length=256)
    purpose: str | None = Field(default=None, max_length=2000)
    sentAt: int | str | None = None


class PendingConnectionRequestItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=128)
    status: str = Field(default="pending", max_length=64)
    counterpartUserId: str = Field(min_length=1, max_length=128)
    counterpartDisplayName: str | None = Field(default=None, max_length=256)
    counterpartPhotoUrl: str | None = Field(default=None, max_length=1024)
    createdAt: str | None = Field(default=None, max_length=64)


class InformationDiscoveryProjection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation: _DISCOVERY_OPERATIONS
    people: list[DirectoryPerson] = Field(default_factory=list, max_length=2000)
    hasMore: StrictBool = False
    catalog: RequestableCatalog | None = None
    pending: list[PendingInformationRequest] = Field(default_factory=list, max_length=100)
    grantedShares: list[GrantedShareItem] = Field(default_factory=list, max_length=200)
    pendingIncoming: list[PendingIncomingRequestItem] = Field(default_factory=list, max_length=100)
    activeGrants: list[ActiveGrantDiscoveryItem] = Field(default_factory=list, max_length=100)
    paidScopes: list[StrictStr] = Field(default_factory=list, max_length=200)
    outgoingRequests: list[OutgoingInformationRequestItem] = Field(
        default_factory=list, max_length=50
    )
    connectionRequests: list[PendingConnectionRequestItem] = Field(
        default_factory=list, max_length=100
    )


def project_information_discovery(raw: Any) -> dict:
    result = InformationDiscoveryProjection.model_validate(raw).model_dump()
    if (result["operation"] == "catalog") != (result["catalog"] is not None):
        raise ValueError("invalid_information_catalog")
    return result


async def read_information_discovery(owner: str, options: InformationDiscoveryOptions) -> dict:
    from hushh_mcp.services.connections_service import ConnectionsService
    from hushh_mcp.services.person_profile_service import PersonProfileService

    result: dict[str, Any] = {"operation": options.operation}
    if options.operation == "pending":
        from hushh_mcp.services.information_request_service import InformationRequestService

        result["pending"] = await InformationRequestService().pending_for_scope_refs(
            requester_user_id=owner, person_ref=options.person_ref, scope_refs=options.scope_refs
        )
    elif options.operation == "granted_shares":
        from hushh_mcp.consent.scope_icons import normalize_or_infer_scope_icon
        from hushh_mcp.one_adk.shared_with_me_card import build_shared_with_me_cards
        from hushh_mcp.services.information_request_service import InformationRequestService

        raw_shares = await InformationRequestService().list_granted_shares(
            requester_user_id=owner,
            person_ref=options.person_ref.strip() or None,
        )
        scope_ref_by_request = {
            str(s.get("requestId")): str(s["scopeRef"])
            for s in raw_shares
            if s.get("requestId") and s.get("scopeRef")
        }
        cards = build_shared_with_me_cards(raw_shares)
        projected_shares: list[dict[str, Any]] = []
        for card in cards:
            person_meta = card.get("person") or {}
            pref = str(person_meta.get("personRef") or options.person_ref.strip() or "").strip()
            if not pref:
                continue
            pname = str(person_meta.get("displayName") or "Hussh member")
            for item in card.get("items") or []:
                req_id = str(item["requestId"])
                lbl = str(item["label"])
                projected_shares.append(
                    {
                        "personRef": pref,
                        "person": pname,
                        "grantRef": str(item["grantRef"]),
                        "requestId": req_id,
                        "bundleId": item.get("bundleId"),
                        "scopeRef": scope_ref_by_request.get(req_id),
                        "iconName": normalize_or_infer_scope_icon(label=lbl),
                        "label": lbl,
                        "sensitivity": (
                            "standard" if item.get("sensitivity") == "standard" else "sensitive"
                        ),
                        "fieldOutline": [str(x) for x in (item.get("fieldOutline") or [])],
                        "fields": [
                            {
                                "name": str(f["name"]),
                                "sensitivity": (
                                    "standard"
                                    if f.get("sensitivity") == "standard"
                                    else "sensitive"
                                ),
                            }
                            for f in (item.get("fields") or [])
                        ],
                        "sharedAt": item.get("sharedAt"),
                        "accessEndsAt": item.get("accessEndsAt"),
                        "purpose": item.get("purpose"),
                        "decryptable": bool(item.get("decryptable", True)),
                    }
                )
        result["grantedShares"] = projected_shares
    elif options.operation == "catalog":
        from hushh_mcp.services.client_connector_service import get_client_connector_service

        catalog = await PersonProfileService().get_requestable_catalog(
            viewer_user_id=owner, public_person_ref=options.person_ref
        )
        connector = await get_client_connector_service().get(user_id=owner)
        result["catalog"] = {
            "personRef": catalog["personRef"],
            "requestableScopes": catalog["requestableScopes"],
            "connectorReady": bool((connector or {}).get("configured")),
        }
    elif options.operation == "pending_incoming":
        from hushh_mcp.services.consent_lifecycle_service import ConsentLifecycleService

        rows = await ConsentLifecycleService().list_pending_incoming(owner, limit=options.limit)
        result["pendingIncoming"] = [
            {
                "requestId": str(r.get("requestId") or ""),
                "requestIds": [str(x) for x in (r.get("requestIds") or []) if x],
                "requesterLabel": str(r.get("requesterLabel") or "Someone"),
                "requesterType": str(r.get("requesterType") or "unknown"),
                "description": str(r.get("description") or "some of your information"),
                "reason": str(r["reason"]) if r.get("reason") else None,
                "bundleLabel": str(r["bundleLabel"]) if r.get("bundleLabel") else None,
                "bundleScopeCount": (
                    int(r["bundleScopeCount"])
                    if isinstance(r.get("bundleScopeCount"), int)
                    and not isinstance(r.get("bundleScopeCount"), bool)
                    else None
                ),
                "issuedAt": (
                    r.get("issuedAt")
                    if isinstance(r.get("issuedAt"), (int, str))
                    and not isinstance(r.get("issuedAt"), bool)
                    else (str(r["issuedAt"]) if r.get("issuedAt") is not None else None)
                ),
                "expiresAt": (
                    r.get("expiresAt")
                    if isinstance(r.get("expiresAt"), (int, str))
                    and not isinstance(r.get("expiresAt"), bool)
                    else (str(r["expiresAt"]) if r.get("expiresAt") is not None else None)
                ),
            }
            for r in rows
        ]
    elif options.operation == "active_grants":
        from hushh_mcp.services.consent_lifecycle_service import ConsentLifecycleService
        from hushh_mcp.services.scope_commerce import ScopeCommerceService

        async def _safe_tariffs() -> list[Any]:
            try:
                return list(await ScopeCommerceService().list_tariffs(owner_user_id=owner))
            except Exception:  # noqa: BLE001 - paid tariff lookup is additive protection
                return []

        rows, tariffs = await asyncio.gather(
            ConsentLifecycleService().list_active_grants(owner, limit=options.limit),
            _safe_tariffs(),
        )
        result["activeGrants"] = [
            {
                "scope": str(r.get("scope") or ""),
                "requestId": str(r["requestId"]) if r.get("requestId") else None,
                "label": str(r.get("label") or "some of your information"),
                "holderLabel": str(r.get("holderLabel") or "someone"),
                "issuedAt": (
                    r.get("issuedAt")
                    if isinstance(r.get("issuedAt"), (int, str))
                    and not isinstance(r.get("issuedAt"), bool)
                    else (str(r["issuedAt"]) if r.get("issuedAt") is not None else None)
                ),
                "expiresAt": (
                    r.get("expiresAt")
                    if isinstance(r.get("expiresAt"), (int, str))
                    and not isinstance(r.get("expiresAt"), bool)
                    else (str(r["expiresAt"]) if r.get("expiresAt") is not None else None)
                ),
            }
            for r in rows
            if str(r.get("scope") or "").strip()
        ]
        paid_scopes: list[str] = []
        for t in tariffs:
            mode = str(
                getattr(t, "pricing_mode", None)
                or (t.get("pricing_mode") if isinstance(t, dict) else "")
                or ""
            ).lower()
            amt = (
                getattr(t, "amount_cents", None)
                if not isinstance(t, dict)
                else t.get("amount_cents")
            )
            is_paid = mode not in {"", "free"} or (isinstance(amt, (int, float)) and amt > 0)
            if is_paid:
                for key in ("machine_scope", "scope_handle"):
                    val = getattr(t, key, None) if not isinstance(t, dict) else t.get(key)
                    if isinstance(val, str) and val.strip():
                        paid_scopes.append(val.strip())
        result["paidScopes"] = sorted(set(paid_scopes))
    elif options.operation == "outgoing_requests":
        from hushh_mcp.services.information_request_service import InformationRequestService

        rows = await InformationRequestService().list_outgoing(
            requester_user_id=owner, limit=min(options.limit, 50)
        )
        result["outgoingRequests"] = [
            {
                "bundleId": str(r.get("bundleId") or ""),
                "personRef": str(r.get("personRef") or ""),
                "displayName": str(r.get("displayName") or "that person"),
                "purpose": str(r["purpose"]) if r.get("purpose") else None,
                "sentAt": (
                    r.get("sentAt")
                    if isinstance(r.get("sentAt"), (int, str))
                    and not isinstance(r.get("sentAt"), bool)
                    else (str(r["sentAt"]) if r.get("sentAt") is not None else None)
                ),
            }
            for r in rows
            if str(r.get("bundleId") or "").strip()
        ]
    elif options.operation == "connection_requests":
        direction = "outgoing" if options.query.strip().lower() == "outgoing" else "incoming"
        rows = await asyncio.to_thread(
            ConnectionsService().list_requests, owner, direction=direction
        )
        result["connectionRequests"] = [
            {
                "id": str(r.get("id") or ""),
                "status": str(r.get("status") or "pending"),
                "counterpartUserId": str(r.get("counterpartUserId") or ""),
                "counterpartDisplayName": (
                    str(r["counterpartDisplayName"]) if r.get("counterpartDisplayName") else None
                ),
                "counterpartPhotoUrl": (
                    str(r["counterpartPhotoUrl"]) if r.get("counterpartPhotoUrl") else None
                ),
                "createdAt": str(r["createdAt"]) if r.get("createdAt") else None,
            }
            for r in rows[:100]
            if str(r.get("id") or "").strip() and str(r.get("counterpartUserId") or "").strip()
        ]
    else:
        service = ConnectionsService()
        if options.operation == "connections":
            people = await asyncio.to_thread(service.list_connections, user_id=owner)
        else:
            page = await asyncio.to_thread(
                service.search_directory,
                owner,
                query=options.query,
                page=options.page,
                limit=options.limit,
                name_only=True,
            )
            people = page["items"]
            result["hasMore"] = page["hasMore"]
        result["people"] = [
            {key: row[key] for key in DirectoryPerson.model_fields if key in row} for row in people
        ]
    return project_information_discovery(result)


class PrivateInformationDiscovery:
    def __init__(self, owner: str, client: Any):
        self.owner, self.client = owner, client

    def _read(self, *, fresh: bool = False, **kwargs) -> dict:
        options = InformationDiscoveryOptions(**kwargs)
        params = options.model_dump()
        params["scope_ref"] = params.pop("scope_refs")
        result = project_information_discovery(
            self.client.read(
                "information",
                self.owner,
                params=params,
                **({"fresh": True} if fresh else {}),
            )
        )
        if result["operation"] != options.operation:
            raise PermissionError("information_read_binding_changed")
        return result

    def list_connections(self, *, user_id: str) -> list[dict]:
        if user_id != self.owner:
            raise PermissionError("information_requester_mismatch")
        return self._read(operation="connections")["people"]

    def list_pending_incoming(self, *, limit: int = 20) -> list[dict]:
        return self._read(operation="pending_incoming", limit=limit, fresh=True)["pendingIncoming"]

    def list_active_grants(self, *, limit: int = 20) -> list[dict]:
        return self._read(operation="active_grants", limit=limit, fresh=True)["activeGrants"]

    def list_protected_grant_scopes(self, *, limit: int = 50) -> set[str]:
        payload = self._read(operation="active_grants", limit=limit, fresh=True)
        scopes = {
            str(item.get("scope") or "").strip()
            for item in (payload.get("activeGrants") or [])
            if isinstance(item, dict) and str(item.get("scope") or "").strip()
        }
        for paid in payload.get("paidScopes") or []:
            if isinstance(paid, str) and paid.strip():
                scopes.add(paid.strip())
        return scopes

    def list_outgoing_requests(self, *, limit: int = 11) -> list[dict]:
        return self._read(operation="outgoing_requests", limit=limit, fresh=True)[
            "outgoingRequests"
        ]

    def list_connection_requests(self, *, direction: str = "incoming") -> list[dict]:
        clean_dir = "outgoing" if str(direction).strip().lower() == "outgoing" else "incoming"
        return self._read(operation="connection_requests", query=clean_dir, fresh=True)[
            "connectionRequests"
        ]

    def search_directory(
        self, user_id: str, *, query: str, page: int, limit: int, name_only: bool
    ) -> dict:
        if user_id != self.owner or name_only is not True:
            raise PermissionError("information_requester_mismatch")
        result = self._read(operation="directory", query=query, page=page, limit=limit)
        return {"items": result["people"], "hasMore": result["hasMore"]}

    def pending(self, person_ref: str, scope_refs: list[str]) -> list[dict]:
        return self._read(operation="pending", person_ref=person_ref, scope_refs=scope_refs)[
            "pending"
        ]

    def catalog(self, person_ref: str) -> dict:
        result = self._read(operation="catalog", person_ref=person_ref)["catalog"]
        if result["personRef"] != person_ref:
            raise PermissionError("information_read_binding_changed")
        return result

    def granted_shares(self, person_ref: str = "") -> list[dict]:
        clean_ref = str(person_ref or "").strip()
        shares = self._read(operation="granted_shares", person_ref=clean_ref)["grantedShares"]
        if clean_ref and any(row.get("personRef") != clean_ref for row in shares):
            raise PermissionError("information_read_binding_changed")
        return shares


def private_information_discovery(owner: str) -> PrivateInformationDiscovery | None:
    from hushh_mcp.runtime_settings import pod_mode
    from hushh_mcp.services.pod_owner_cloud import private_pod_runtime
    from hushh_mcp.services.pod_owner_feed_client import OwnerFeedUnavailable, owner_feed_client

    if not pod_mode():
        return None
    if not private_pod_runtime():
        raise OwnerFeedUnavailable("information metadata authority unavailable")
    client = owner_feed_client()
    if client is None:
        raise OwnerFeedUnavailable("information metadata authority unavailable")
    return PrivateInformationDiscovery(owner, client)

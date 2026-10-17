"""Metadata adapters for the existing person resolver and request proposal in owner pods."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool


class InformationDiscoveryOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["connections", "directory", "catalog", "pending"]
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


class InformationDiscoveryProjection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation: Literal["connections", "directory", "catalog", "pending"]
    people: list[DirectoryPerson] = Field(default_factory=list, max_length=2000)
    hasMore: StrictBool = False
    catalog: RequestableCatalog | None = None
    pending: list[PendingInformationRequest] = Field(default_factory=list, max_length=100)


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

    def _read(self, **kwargs) -> dict:
        options = InformationDiscoveryOptions(**kwargs)
        params = options.model_dump()
        params["scope_ref"] = params.pop("scope_refs")
        result = project_information_discovery(
            self.client.read("information", self.owner, params=params)
        )
        if result["operation"] != options.operation:
            raise PermissionError("information_read_binding_changed")
        return result

    def list_connections(self, *, user_id: str) -> list[dict]:
        if user_id != self.owner:
            raise PermissionError("information_requester_mismatch")
        return self._read(operation="connections")["people"]

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


def private_information_discovery(owner: str) -> PrivateInformationDiscovery | None:
    from hushh_mcp.runtime_settings import pod_mode
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent
    from hushh_mcp.services.pod_owner_feed_client import OwnerFeedUnavailable, owner_feed_client

    if not pod_mode():
        return None
    if not owner_cloud_agent():
        raise OwnerFeedUnavailable("information metadata authority unavailable")
    client = owner_feed_client()
    if client is None:
        raise OwnerFeedUnavailable("information metadata authority unavailable")
    return PrivateInformationDiscovery(owner, client)

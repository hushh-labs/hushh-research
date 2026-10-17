"""Cosmetic curated catalog projection; never connection or tool authority."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from hushh_mcp.services.stripe_mcp_policy import official_stripe_endpoint, stripe_readiness


class CatalogRecord(Protocol):
    @property
    def connector_id(self) -> str: ...
    @property
    def display_name(self) -> str: ...
    @property
    def description(self) -> str: ...


@dataclass(frozen=True)
class CuratedConnectorCatalogEntry:
    connector_id: str
    display_name: str
    description: str
    catalog_state: Literal["setup_pending", "discovery_pending"]


def catalog_entries(
    manifests: Mapping[str, CatalogRecord], registrations: Mapping[str, CatalogRecord]
) -> dict[str, CuratedConnectorCatalogEntry]:
    entries = {
        identifier: CuratedConnectorCatalogEntry(
            item.connector_id, item.display_name, item.description, "setup_pending"
        )
        for identifier, item in manifests.items()
    }
    entries.update(
        {
            identifier: CuratedConnectorCatalogEntry(
                item.connector_id, item.display_name, item.description, "discovery_pending"
            )
            for identifier, item in registrations.items()
        }
    )
    return entries


def owner_status_fields(status: dict[str, Any] | None) -> dict[str, Any]:
    status = status or {}
    return {
        "status": status.get("status", "not_connected"),
        "accountLabel": status.get("accountLabel"),
        "connectedAt": status.get("connectedAt"),
        "validationState": status.get("validationState", "unverified"),
        "profile": status.get("profile"),
        "revocationOutcome": status.get("revocationOutcome", "not_attempted"),
        "lastErrorCode": status.get("lastErrorCode"),
    }


def catalog_card_is_hidden(
    *, status: str, catalog_state: str | None, stripe_readiness: object
) -> bool:
    """Keep actionable Stripe setup and existing grants; hide other pending cards."""
    return (
        stripe_readiness is None
        and catalog_state is not None
        and status in {"not_connected", "revoked"}
    )


def catalog_summary_fields(
    entry: CatalogRecord,
    *,
    status: dict[str, Any] | None,
    available: bool,
    curated_oauth: bool,
    catalog_state: str | None,
) -> dict[str, Any]:
    return {
        "connectorId": entry.connector_id,
        "displayName": entry.display_name,
        "description": entry.description,
        "authStyle": "oauth",
        "registrationKind": "curated",
        "curatedOAuth": curated_oauth,
        "catalogCard": True,
        "catalogState": catalog_state,
        "available": available,
        **owner_status_fields(status),
        "stripeReadiness": stripe_readiness() if entry.connector_id == "stripe" else None,
    }


def registry_summary_fields(
    connector: Any, *, status: dict[str, Any] | None, available: bool, curated_oauth: bool
) -> dict[str, Any]:
    return {
        "connectorId": connector.connector_id,
        "displayName": connector.display_name,
        "description": connector.description,
        "authStyle": connector.auth_style,
        "registrationKind": "private" if connector.owner_user_id else "curated",
        "curatedOAuth": curated_oauth,
        "available": available,
        **owner_status_fields(status),
        "stripeReadiness": stripe_readiness(
            tooling_connected=bool(
                status
                and status.get("status") == "connected"
                and status.get("validationState") == "verified"
            )
        )
        if official_stripe_endpoint(getattr(connector, "mcp_endpoint", ""))
        else None,
    }

"""Owner-scoped, coordinate-free observations for one transient semantic turn.

These are service adapters, never executable action bindings. Candidate handles
are request-local labels; preparers must re-read the owning resource before use.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from hushh_mcp.operons.location.references import LocationObservation, fresh_observations


class CommandReadInputError(ValueError):
    """A public bounded-read validation message, never a service exception."""


class LocationCommandReadService:
    def __init__(
        self,
        *,
        user_id: str,
        connections: Any = None,
        circles: Any = None,
        location: Any = None,
        observations: list[LocationObservation] | None = None,
        saved_observations: list[LocationObservation] | None = None,
    ):
        self.user_id = user_id
        self._connections, self._circles, self._location = connections, circles, location
        saved = fresh_observations(
            saved_observations or [], retention=timedelta(hours=24, minutes=15)
        )
        self._saved_handles = {value.reference for value in saved} - {
            value.reference for value in fresh_observations(observations or [])
        }
        self.references: dict[str, dict[str, str]] = {
            value.reference: value.model_dump(mode="json", exclude={"reference"})
            for value in [*saved, *fresh_observations(observations or [])]
        }
        self._calls = 0
        self._imported_count = len(self.references)

    def observations(self, required: set[str] | None = None) -> list[dict[str, str]]:
        # Imported locators plus at most 50 new reads may coexist during this
        # transient model turn. Only 50 leave it, with selected handles pinned.
        required = required or set()
        pinned = [
            {"reference": key, **value} for key, value in self.references.items() if key in required
        ]
        remaining = [
            {"reference": key, **value}
            for key, value in self.references.items()
            if key not in required
        ]
        if len(pinned) > 50:
            raise CommandReadInputError("The selected references exceed the session bound.")
        return pinned + (remaining[-(50 - len(pinned)) :] if len(pinned) < 50 else [])

    def semantic_observations(self) -> list[dict[str, str]]:
        return [
            {
                "reference": key,
                "observation_status": "saved_selection_needs_refresh"
                if key in self._saved_handles
                else "recent_observation",
                **{field: value[field] for field in ("kind", "name", "observed_at")},
            }
            for key, value in self.references.items()
        ]

    async def observe_created_circles(self, results: list[dict[str, Any]]) -> list[dict[str, str]]:
        """Refresh receipt identities under this owner; these locators grant nothing."""
        identities = {item["id"] for item in results[:12] if item.get("kind") == "circle"}
        if not identities:
            return []
        try:

            def read():
                self._services()
                return self._circles.list_circles(user_id=self.user_id)

            circles = await asyncio.wait_for(asyncio.to_thread(read), timeout=8)
            for circle in circles:
                identity = str(circle.get("id") or "")
                if identity in identities:
                    self._reference(
                        "circle",
                        identity,
                        circle.get("name"),
                        handle="candidate_"
                        + uuid5(
                            NAMESPACE_URL, f"one.location.created-circle:{self.user_id}:{identity}"
                        ).hex,
                    )
            return self.observations()
        except Exception:
            # Optional follow-up context must not hide a committed operation.
            return []

    def _reference(
        self, kind: str, identity: str, label: Any, *, handle: str | None = None
    ) -> dict[str, str]:
        if not identity:
            raise CommandReadInputError("The owning service returned an invalid candidate.")
        name = str(label or kind.title()).strip()[:120]
        if name == identity:
            name = kind.title()
        for reference, value in self.references.items():
            if value["kind"] == kind and value["id"] == identity:
                self._saved_handles.discard(reference)
                value.update(name=name, observed_at=datetime.now(UTC).isoformat())
                return {"reference": reference, "name": name}
        if len(self.references) >= self._imported_count + 50:
            raise CommandReadInputError("Narrow the request before reading more candidates.")
        reference = handle or "candidate_" + uuid4().hex
        self.references[reference] = {
            "kind": kind,
            "id": identity,
            "name": name,
            "observed_at": datetime.now(UTC).isoformat(),
        }
        return {"reference": reference, "name": name}

    def _resolve(self, reference: str, kind: str) -> str:
        value = self.references.get(reference)
        if not value or value["kind"] != kind:
            raise CommandReadInputError(
                "Read the current candidate list before selecting a reference."
            )
        return value["id"]

    def _services(self):
        # Only this adapter sees mutable services. The injected tool roster
        # exposes the bounded read methods below and nothing else.
        from hushh_mcp.services.connections_service import ConnectionsService
        from hushh_mcp.services.one_location_agent_service import OneLocationAgentService
        from hushh_mcp.services.one_location_circle_service import OneLocationCircleService

        self._connections = self._connections or ConnectionsService()
        self._circles = self._circles or OneLocationCircleService()
        self._location = self._location or OneLocationAgentService()

    async def read(
        self, kind: str, *, query: str = "", reference: str = "", page: int = 1, limit: int = 20
    ) -> dict[str, Any]:
        if (
            len(query) > 160
            or len(reference) > 128
            or isinstance(page, bool)
            or not 1 <= page <= 250
            or isinstance(limit, bool)
            or not 1 <= limit <= 20
        ):
            raise CommandReadInputError("The requested read exceeds its bounds.")
        self._calls += 1
        if self._calls > 10:
            raise CommandReadInputError("The command read budget is exhausted. Narrow the request.")
        try:
            # Result shaping and reference allocation are sequential on the
            # event loop even when ADK emits concurrent read calls.
            value = await asyncio.wait_for(
                asyncio.to_thread(self._read, kind, query, reference, page, limit), timeout=8
            )
            return self._project(kind, value, page, limit)
        except CommandReadInputError:
            raise
        except Exception:
            # No SQL errors, identity values or provider payloads reach the
            # tool exception logger or the semantic model.
            return {
                "status": "unavailable",
                "reason": "The owning service could not verify this information.",
            }

    def _read(self, kind: str, query: str, reference: str, page: int, limit: int) -> Any:
        self._services()
        if kind in {"connections", "directory"}:
            operation = (
                self._connections.list_connections_page
                if kind == "connections"
                else self._connections.search_directory
            )
            return operation(self.user_id, query=query, page=page, limit=limit)
        if kind == "circles":
            values = self._circles.list_circles(user_id=self.user_id)
            # The owning legacy list is complete. Stable order and explicit
            # paging keep observations bounded without silently dropping an audience.
            values = sorted(
                values, key=lambda row: (str(row.get("name") or ""), str(row.get("id") or ""))
            )
            offset = (page - 1) * limit
            return {
                "items": values[offset : offset + limit],
                "hasMore": offset + limit < len(values),
                "totalCount": len(values),
            }
        if kind == "members":
            return self._circles.list_circle_members_page(
                user_id=self.user_id,
                circle_id=self._resolve(reference, "circle"),
                query=query,
                page=page,
                limit=limit,
            )
        if kind == "settings":
            approval = self._location.get_auto_approve_preference(user_id=self.user_id)
            scope = approval.get("scope") or {}
            identifiers = {scope.get("circleId"), *(scope.get("circleIds") or [])} - {None, ""}
            circles = self._circles.list_circles(user_id=self.user_id) if identifiers else []
            return {
                "autoApproval": approval,
                "scopeCircles": [row for row in circles if row.get("id") in identifiers],
                "scopeComplete": identifiers <= {row.get("id") for row in circles},
                "map": self._location.get_map_preferences(user_id=self.user_id),
            }
        if kind in {"shares", "requests", "links"}:
            return self._location.observe_command_status(
                user_id=self.user_id, kind=kind, page=page, limit=limit
            )
        if kind == "nearby":
            # Coordinates belong to the device. Only an explicitly supplied
            # provider result observation can make this read available.
            places = [
                value
                for value in self.semantic_observations()
                if value["kind"] == "place"
                and value["observation_status"] != "saved_selection_needs_refresh"
            ]
            return (
                {"status": "observed", "items": places[:10]}
                if places
                else {
                    "status": "needs_client_observation",
                    "reason": "Run the authored Nearby search to obtain current provider results.",
                }
            )
        raise CommandReadInputError("This Location read is not declared.")

    def _project(self, kind: str, value: Any, page: int, limit: int) -> dict[str, Any]:
        if kind == "nearby":
            return value
        if kind == "links":
            return {
                "status": "observed",
                "page": page,
                "hasMore": bool(value.get("hasMore")),
                "items": [
                    {key: row.get(key) for key in ("status", "expiresAt", "durationHours")}
                    for row in value.get("items", [])[:limit]
                ],
            }
        if kind == "settings":
            approval, map_value = value["autoApproval"], value["map"]
            return {
                "status": "observed",
                "autoApproval": {
                    "enabled": approval.get("enabled"),
                    "scopeKind": (approval.get("scope") or {}).get("kind"),
                    "ruleVersion": approval.get("ruleVersion"),
                    "scopeComplete": value["scopeComplete"],
                    "circles": [
                        self._reference("circle", row["id"], row.get("name"))
                        for row in value["scopeCircles"]
                    ],
                },
                "map": {"presenceMode": map_value.get("presenceMode")},
            }
        items = []
        for row in value.get("items", [])[:limit]:
            if kind == "circles":
                item = {
                    **self._reference("circle", str(row.get("id") or ""), row.get("name")),
                    "kind": row.get("kind"),
                    "memberCount": row.get("memberCount"),
                    "canManageMembers": bool(
                        (row.get("viewerCapabilities") or {}).get("canManageMembers")
                    ),
                }
            elif kind in {"shares", "requests"}:
                item = {
                    **self._reference(
                        "share" if kind == "shares" else "request",
                        str(row.get("id") or ""),
                        row.get("personName"),
                    ),
                    **{key: row.get(key) for key in ("direction", "status", "expiresAt")},
                }
            else:
                item = {
                    **self._reference(
                        "person", str(row.get("userId") or ""), row.get("displayName")
                    ),
                    "relationship": "connected"
                    if kind == "connections"
                    else row.get("relationship", "unknown"),
                    "role": row.get("role"),
                }
            items.append(item)
        return {
            "status": "observed",
            "items": items,
            "page": page,
            "hasMore": bool(value.get("hasMore")),
            "totalCount": value.get("totalCount"),
        }

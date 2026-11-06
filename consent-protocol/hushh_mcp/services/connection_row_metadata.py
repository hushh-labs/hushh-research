"""Batched, live-qualified portraits and relationship labels for network rows."""

from __future__ import annotations

import json
from typing import Any, Callable

from hushh_mcp.services.connection_mutuals import PAGE_ROW_METADATA_SQL


class ConnectionRowMetadata:
    def __init__(
        self,
        connections: Any,
        viewer: str,
        people: list[dict[str, Any]],
        profiles: Callable[[str, list[str]], list[dict[str, Any]]],
    ) -> None:
        self.connections = connections
        self.viewer = viewer
        self.total_count: int | None = None
        self.people = {str(p["userId"]): p for p in people}
        if len(self.people) > 50:
            raise self.unavailable()
        self.params: dict[str, Any] = {
            "user_id": viewer,
            "owner_user_id": viewer,
            "page_user_ids": sorted(self.people),
            "preview_refs": "{}",
        }
        self.initial = self.read()
        preview_ids = sorted(
            {str(uid) for row in self.initial.values() for uid in row["preview_user_ids"]}
        )
        self.previews = (
            {str(p["userId"]): p for p in profiles(viewer, preview_ids)} if preview_ids else {}
        )
        self.params["preview_refs"] = json.dumps(
            {
                uid: p["publicPersonRef"]
                for uid, p in self.previews.items()
                if p.get("publicPersonRef")
            }
        )

    @staticmethod
    def unavailable() -> Exception:
        from hushh_mcp.services.connections_service import ConnectionsError

        return ConnectionsError(
            "CONNECTION_NETWORK_UNAVAILABLE",
            "This network changed. Please try again.",
            status_code=503,
        )

    def read(
        self,
        qualification: str | None = None,
        params: dict[str, Any] | None = None,
        context_sql: str | None = None,
    ) -> dict[str, dict[str, Any]]:
        if not self.people and not context_sql:
            return {}
        sql = PAGE_ROW_METADATA_SQL
        if context_sql:
            sql = f"""WITH metadata AS ({PAGE_ROW_METADATA_SQL}), qualified AS ({qualification}),
                context AS ({context_sql})
                SELECT metadata.*, qualified.degree, qualified.overflow,
                    context.target_available, context.total_count FROM context
                LEFT JOIN metadata ON TRUE
                LEFT JOIN qualified ON qualified.user_id = metadata.candidate_id"""  # nosec B608
        elif qualification:
            sql = f"""WITH metadata AS ({PAGE_ROW_METADATA_SQL}), qualified AS ({qualification})
                SELECT metadata.*, qualified.degree, qualified.overflow FROM metadata
                JOIN qualified ON qualified.user_id = metadata.candidate_id
                WHERE NOT EXISTS (SELECT 1 FROM qualified WHERE overflow)"""  # nosec B608
        rows = self.connections._execute_many(sql, {**self.params, **(params or {})})
        if context_sql:
            if not rows or any(not row["target_available"] for row in rows):
                raise self.unavailable()
            self.total_count = int(rows[0]["total_count"])
            if any(row.get("candidate_id") and row.get("degree") is None for row in rows):
                raise self.unavailable()
        result = {str(row["candidate_id"]): row for row in rows if row.get("candidate_id")}
        if set(result) != set(self.people) or any(row.get("overflow") for row in rows):
            raise self.unavailable()
        return result

    def settle(
        self,
        qualification: str | None = None,
        params: dict[str, Any] | None = None,
        context_sql: str | None = None,
    ) -> dict[str, dict[str, Any]]:
        final = self.read(qualification, params, context_sql)
        for uid, row in final.items():
            previous = self.initial[uid]
            if (
                int(row["mutual_count"]) != int(previous["mutual_count"])
                or list(row["preview_user_ids"]) != list(previous["preview_user_ids"])
                or not row["previews_valid"]
                or str(row["public_person_ref"]) != str(self.people[uid].get("publicPersonRef"))
            ):
                raise self.unavailable()
        return {
            uid: {
                "relationship": row["relationship"],
                "mutualConnectionCount": int(row["mutual_count"]),
                "mutualConnectionPreviews": self.preview_payload(row),
                "mutualConnectionPreview": next(iter(self.preview_payload(row)), None),
                **({"networkDegree": row["degree"]} if "degree" in row else {}),
            }
            for uid, row in final.items()
        }

    def preview_payload(self, row: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            {key: peer.get(key) for key in ("publicPersonRef", "displayName", "photoUrl")}
            for uid in row["preview_user_ids"]
            if (peer := self.previews.get(str(uid))) and peer.get("publicPersonRef")
        ]

"""Owner-filtered metadata reads for the one canonical scope-catalog reducer.

The async connection retains caller transaction ownership; the lazy synchronous
client is used only by ordinary discovery. No second scope or handle policy lives
in this transport seam.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any


async def read_scope_catalog_rows(
    database: Callable[[], Any], user_id: str, *, connection: Any = None
) -> dict[str, list[dict]]:
    sources = (
        ("pkm_index", "available_domains", ("available_domains",)),
        (
            "pkm_manifests",
            "domain,top_level_scope_paths,externalizable_paths,manifest_version,summary_projection",
            ("top_level_scope_paths", "externalizable_paths", "summary_projection"),
        ),
        (
            "pkm_manifest_paths",
            "domain,json_path,path_type,segment_id,exposure_eligibility,consent_label,scope_handle,sensitivity_label",
            (),
        ),
        (
            "pkm_scope_registry",
            "domain,scope_handle,scope_label,exposure_enabled,visibility_posture,default_projection_ready,default_projection_updated_at,summary_projection,manifest_version",
            ("summary_projection",),
        ),
    )
    # Only these authored tables/columns can enter this metadata projection.
    statements = {
        "pkm_index": "SELECT available_domains FROM pkm_index WHERE user_id=$1 LIMIT 1",
        "pkm_manifests": "SELECT domain,top_level_scope_paths,externalizable_paths,manifest_version,summary_projection FROM pkm_manifests WHERE user_id=$1",
        "pkm_manifest_paths": "SELECT domain,json_path,path_type,segment_id,exposure_eligibility,consent_label,scope_handle,sensitivity_label FROM pkm_manifest_paths WHERE user_id=$1",
        "pkm_scope_registry": "SELECT domain,scope_handle,scope_label,exposure_enabled,visibility_posture,default_projection_ready,default_projection_updated_at,summary_projection,manifest_version FROM pkm_scope_registry WHERE user_id=$1",
    }
    result = {}
    for table, columns, json_columns in sources:
        if connection is not None:
            rows = [dict(row) for row in await connection.fetch(statements[table], user_id)]
            # asyncpg's default JSONB codec returns text; the synchronous
            # client returns decoded objects. Feed one reducer the same shape.
            for row in rows:
                for column in json_columns:
                    if isinstance(row.get(column), str):
                        row[column] = json.loads(row[column])
        else:

            def read(table: str = table, columns: str = columns):
                query = database().table(table).select(columns).eq("user_id", user_id)
                return (query.limit(1) if table == "pkm_index" else query).execute()

            rows = (await asyncio.to_thread(read)).data or []
        result[table] = rows
    return result

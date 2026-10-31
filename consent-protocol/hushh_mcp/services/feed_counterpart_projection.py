"""Bounded public identity projection for viewer-owned Feed rows."""

from typing import Any

COUNTERPART_PHOTO_KEY = "counterpart_photo_url"
COUNTERPART_PROFILE_KEY = "counterpart_person_ref"


def with_counterpart_identity(
    rows: list[dict[str, Any]],
    photos: dict[str, str | None],
    profile_refs: dict[str, str],
) -> list[dict[str, Any]]:
    """Current empty values clear snapshots after identity removal or erasure."""
    return [
        {
            **row,
            "metadata": {
                **(row["metadata"] if isinstance(row.get("metadata"), dict) else {}),
                COUNTERPART_PHOTO_KEY: photos.get(str(row.get("id"))),
                COUNTERPART_PROFILE_KEY: profile_refs.get(str(row.get("id"))),
            },
        }
        for row in rows
    ]


def without_counterpart_identity(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """An unavailable current lookup must not resurrect an old identity."""
    return [
        {
            **row,
            "metadata": {
                key: value
                for key, value in (
                    row["metadata"] if isinstance(row.get("metadata"), dict) else {}
                ).items()
                if key not in {COUNTERPART_PHOTO_KEY, COUNTERPART_PROFILE_KEY}
            },
        }
        for row in rows
    ]

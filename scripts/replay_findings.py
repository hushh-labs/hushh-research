#!/usr/bin/env python3
"""Report saved Drive incident evidence; never retry payments, grants or copies.

The recorded comparisons contain equality flags, not raw checksums/identities.
They cannot honestly be replayed through a production copy guard.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "consent-protocol"))

from hushh_mcp.services.drive_date_ontology import match_activity_dates  # noqa: E402


def _row_report(row, period, *, private, legacy_matcher):
    if not isinstance(row, dict):
        raise ValueError("findings_schema_invalid_row")
    union, legacy = None, None
    if isinstance(period, dict) and all(
        period.get(key) for key in ("start", "end", "timezone")
    ):
        union = match_activity_dates(row, period)
        if legacy_matcher is not None:
            try:
                legacy = legacy_matcher(
                    {
                        "name": row.get("name"),
                        "created_time": row.get("createdTime"),
                        "modified_time": row.get("modifiedTime"),
                    },
                    period,
                    precedence=True,
                )
            except (ValueError, TypeError, KeyError):
                pass
    return {
        "position": row.get("position"),
        "shareable": row.get("shareable"),
        "legacy_date_counterfactual": legacy,
        "activity_date_counterfactual": union,
        "missing_raw_identity": "id" not in row,
        **(
            {
                "name": row.get("name"),
                "createdTime": row.get("createdTime"),
                "modifiedTime": row.get("modifiedTime"),
            }
            if private
            else {}
        ),
    }


def _comparison_report(item, *, private):
    if not isinstance(item, dict):
        raise ValueError("findings_schema_invalid_comparison")
    equal = item.get("equal")
    fields = (
        "id",
        "name",
        "mime",
        "size",
        "md5Checksum",
        "sha256Checksum",
        "headRevisionId",
    )
    pattern = (
        isinstance(equal, dict)
        and all(equal.get(field) is True for field in fields)
        and equal.get("modifiedTime") is False
    )
    return {
        "position": item.get("position"),
        "recorded_equality": equal,
        "timestamp_only_pattern": pattern,
        "guard_replay": "unavailable_raw_snapshots_missing",
        **(
            {
                "name": item.get("name"),
                "frozen_modified_time": item.get("frozen_modified_time"),
                "live_modified_time": item.get("live_modified_time"),
            }
            if private
            else {}
        ),
    }


def build_report(data, *, private=False, legacy_matcher=None):
    checkpoint = data.get("saved_owner_search_checkpoint", {})
    rows = checkpoint.get("results")
    comparisons = data.get("after_fix_live_metadata_comparison")
    if not isinstance(rows, list) or not isinstance(comparisons, list):
        raise ValueError("findings_schema_missing_recorded_arrays")
    period = checkpoint.get("saved_selection", {}).get("requested_period")
    details = [
        _row_report(row, period, private=private, legacy_matcher=legacy_matcher)
        for row in rows
    ]
    comparisons_report = [
        _comparison_report(item, private=private) for item in comparisons
    ]
    return {
        "schema_version": 1,
        "request_tag": checkpoint.get("request_tag"),
        "saved_provider_rows": len(rows),
        "saved_shareable_rows": sum(row.get("shareable") is True for row in rows),
        "saved_unshareable_rows": sum(row.get("shareable") is False for row in rows),
        "recorded_metadata_comparisons": len(comparisons),
        "timestamp_only_comparison_patterns": sum(
            row["timestamp_only_pattern"] for row in comparisons_report
        ),
        "date_counterfactual_basis": "available_saved_metadata_only",
        "legacy_rule_replayed": legacy_matcher is not None,
        "original_copy_jobs_recreated": False,
        "live_copy_delivery_verified": False,
        "rows": details,
        "copy_comparisons": comparisons_report,
        **(
            {
                "saved_provider_queries": checkpoint.get("provider_queries"),
                "saved_semantic_plan": checkpoint.get("semantic_plan"),
                "saved_period": period,
                "roles": data.get("roles"),
            }
            if private
            else {}
        ),
        "limitations": [
            "Recorded equality flags cannot reconstruct raw source identities or prove transfer integrity.",
            "Missing activity/photo metadata remains unknown; it is not invented.",
            "A date counterfactual does not reinterpret an existing paid selection.",
            "The timestamp change trigger and original failing stage require contemporaneous evidence.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("findings", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--include-private",
        action="store_true",
        help="Write exact saved queries/names/roles to the local output file only.",
    )
    parser.add_argument(
        "--legacy-runtime",
        action="store_true",
        help="Use the actual legacy helper in an already configured application environment.",
    )
    args = parser.parse_args()
    if args.include_private and args.output is None:
        parser.error("private evidence requires a local --output file")
    legacy_matcher = None
    if args.legacy_runtime:
        from hushh_mcp.services.drive_owner_search_service import _in_requested_period

        legacy_matcher = _in_requested_period
    report = build_report(
        json.loads(args.findings.read_text()),
        private=args.include_private,
        legacy_matcher=legacy_matcher,
    )
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(
            json.dumps(
                {
                    key: report[key]
                    for key in (
                        "schema_version",
                        "saved_provider_rows",
                        "saved_shareable_rows",
                        "saved_unshareable_rows",
                        "recorded_metadata_comparisons",
                        "timestamp_only_comparison_patterns",
                        "live_copy_delivery_verified",
                    )
                }
            )
        )
    else:
        print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

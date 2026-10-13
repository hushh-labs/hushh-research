"""Buyer terms derived only from exact owner-approved document evidence.

No filenames, snippets, private scores, or model-authored gap narratives leave
this boundary. Period limitations are computed from selected cited evidence.
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from hushh_mcp.services.drive_owner_allowed import package_allow_marker


class DisclosurePeriod(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")

    @model_validator(mode="after")
    def ordered(self):
        if date.fromisoformat(self.start) > date.fromisoformat(self.end):
            raise ValueError("invalid coverage period")
        return self


class PackageDisclosure(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schemaVersion: int = Field(ge=1, le=1)
    packageDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    packageRevision: int = Field(ge=1)
    selectedCount: int = Field(ge=1, le=120)
    coverageStatus: str = Field(pattern=r"^(complete|partial|unknown)$")
    periods: list[DisclosurePeriod] = Field(max_length=120)
    limitations: list[str] = Field(max_length=24)

    @model_validator(mode="after")
    def bounded(self):
        if any(not item or len(item) > 300 for item in self.limitations):
            raise ValueError("invalid buyer limitation")
        if self.coverageStatus != "complete" and not self.limitations:
            raise ValueError("incomplete coverage requires a buyer limitation")
        return self


def build_package_disclosure(*, package, purpose, observations):
    periods = []
    selected = set(package["selected_positions"])
    for item in observations:
        if item["position"] not in selected:
            continue
        assessment = item.get("assessment") or {}
        if assessment.get("decision") != "include" or item.get("unreadable_reason"):
            continue
        cited = {citation["source_ref"] for citation in assessment.get("citations", [])}
        for period in assessment.get("covered_periods", []):
            if period["source_refs"] and set(period["source_refs"]) <= cited:
                periods.append(
                    (
                        date.fromisoformat(period["period_start"]),
                        date.fromisoformat(period["period_end"]),
                    )
                )
    merged = []
    for start, end in sorted(set(periods)):
        if merged and start.toordinal() <= merged[-1][1].toordinal() + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    coverage = package["assessment"]["coverage_status"]
    limitations = []
    if coverage == "partial":
        limitations.append("This package covers only part of your request.")
    elif coverage == "unknown":
        limitations.append("Coverage of your request could not be established.")
    start, end = purpose.get("periodStart"), purpose.get("periodEnd")
    if start and end:
        first, last = date.fromisoformat(start), date.fromisoformat(end)
        cursor = first.toordinal()
        missing = []
        for covered_start, covered_end in merged:
            low, high = max(first, covered_start).toordinal(), min(last, covered_end).toordinal()
            if high < low:
                continue
            if cursor < low:
                missing.append((date.fromordinal(cursor), date.fromordinal(low - 1)))
            cursor = max(cursor, high + 1)
        if cursor <= last.toordinal():
            missing.append((date.fromordinal(cursor), last))
        if missing:
            coverage = "partial" if merged else "unknown"
            limitations.extend(
                f"Selected documents do not verify coverage from {low.isoformat()} to {high.isoformat()}."
                for low, high in missing[:23]
            )
            if len(missing) > 23:
                limitations = limitations[:23] + [
                    "Additional requested date intervals have no verified coverage."
                ]
    if coverage != "complete" and not limitations:
        limitations.append("Full coverage of your request could not be verified.")
    if len(merged) > 120:
        coverage = "unknown"
        merged = []
        limitations = limitations[:23] + [
            "The verified coverage contains too many separate date intervals to display here."
        ]
    return PackageDisclosure.model_validate(
        {
            "schemaVersion": 1,
            "packageDigest": package["digest"],
            "packageRevision": package["revision"],
            "selectedCount": len(selected),
            "coverageStatus": coverage,
            "periods": [
                {"start": low.isoformat(), "end": high.isoformat()} for low, high in merged
            ],
            "limitations": limitations,
        }
    ).model_dump()


def buyer_package_disclosure(private, *, request_revision, owner_allowed_at):
    """A sealed current owner Allow is required, including for read projection."""
    marker = package_allow_marker(private)
    if marker is None or owner_allowed_at is None or marker["request_revision"] != request_revision:
        return None
    try:
        value = PackageDisclosure.model_validate(marker.get("buyer_disclosure")).model_dump()
    except (ValidationError, ValueError, TypeError):
        return None
    if (
        value["packageDigest"] != marker["package_digest"]
        or value["packageRevision"] != marker["package_revision"]
        or value["selectedCount"] != marker["package_selected_count"]
    ):
        return None
    return value

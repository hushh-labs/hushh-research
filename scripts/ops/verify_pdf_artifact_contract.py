#!/usr/bin/env python3
"""Verify the single, cross-platform PDF artifact contract. Owner: frontend."""

from __future__ import annotations

from pathlib import Path
import sys


REPO_ROOT = Path(__file__).resolve().parents[2]
CANONICAL_SKILL = REPO_ROOT / "skills/pdf-artifact-generation/SKILL.md"
CLAUDE_BRIDGE = REPO_ROOT / ".claude/skills/pdf-artifact-generation/SKILL.md"
LEGACY_ALIAS = REPO_ROOT / ".claude/skills/morphy-pdf/SKILL.md"
CODEX_BRIDGE = REPO_ROOT / ".codex/skills/founder-brief-curation/references/pdf-artifact-generation.md"
FORMATTER = REPO_ROOT / "hushh-webapp/lib/morphy-ux/pdf-document-formatter.mjs"
EXPORTER = REPO_ROOT / "hushh-webapp/scripts/reports/export-markdown-pdf.mjs"
DESIGN_SYSTEM = REPO_ROOT / "docs/reference/quality/design-system.md"
SKILL_INDEX = REPO_ROOT / "skills/README.md"
MONTHLY_CADENCE = REPO_ROOT / "skills/pdf-artifact-generation/references/monthly-executive-report-cadence.md"
MONTHLY_COLLECTOR = REPO_ROOT / "skills/pdf-artifact-generation/scripts/collect_github_month.py"
MONTHLY_CALENDAR_RENDERER = REPO_ROOT / "skills/pdf-artifact-generation/scripts/render_github_month_calendar.py"


def read(path: Path) -> str:
    if not path.is_file():
        raise AssertionError(f"missing required contract file: {path.relative_to(REPO_ROOT)}")
    return path.read_text(encoding="utf-8")


def frontmatter(source: str) -> str:
    parts = source.split("---", 2)
    if len(parts) != 3 or parts[0]:
        raise AssertionError("expected YAML frontmatter at the start of the skill")
    return parts[1].strip()


def require(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def main() -> int:
    failures: list[str] = []
    try:
        canonical = read(CANONICAL_SKILL)
        claude = read(CLAUDE_BRIDGE)
        legacy = read(LEGACY_ALIAS)
        codex = read(CODEX_BRIDGE)
        formatter = read(FORMATTER)
        exporter = read(EXPORTER)
        design_system = read(DESIGN_SYSTEM)
        skill_index = read(SKILL_INDEX)
        monthly_cadence = read(MONTHLY_CADENCE)
        monthly_collector = read(MONTHLY_COLLECTOR)
        monthly_calendar_renderer = read(MONTHLY_CALENDAR_RENDERER)
    except AssertionError as error:
        print(f"PDF artifact contract failed: {error}", file=sys.stderr)
        return 1

    require("name: pdf-artifact-generation" in frontmatter(canonical), "canonical skill name is not pdf-artifact-generation", failures)
    require(frontmatter(canonical) == frontmatter(claude), "Claude bridge frontmatter does not match the canonical skill", failures)
    require(len(claude.encode("utf-8")) <= 1400, "Claude bridge is too large to remain a discovery-only bridge", failures)
    require("skills/pdf-artifact-generation/SKILL.md" in claude, "Claude bridge does not point to the canonical skill", failures)
    require(len(codex.encode("utf-8")) <= 1100, "Codex bridge is too large to remain a routing-only bridge", failures)
    require("skills/pdf-artifact-generation/SKILL.md" in codex, "Codex bridge does not point to the canonical skill", failures)
    require(len(legacy.encode("utf-8")) <= 1000, "legacy morphy-pdf alias contains behavior instead of a pointer", failures)
    require("skills/pdf-artifact-generation/SKILL.md" in legacy, "legacy morphy-pdf alias does not point to the canonical skill", failures)
    require(not any(term in legacy for term in ("assets/morphy.css", "scripts/render.py", "Manrope")), "legacy morphy-pdf alias revives a private renderer contract", failures)

    legacy_root = LEGACY_ALIAS.parent
    require(not (legacy_root / "assets/morphy.css").exists(), "legacy stylesheet remains active beside the alias", failures)
    require(not (legacy_root / "scripts/render.py").exists(), "legacy renderer remains active beside the alias", failures)
    require(not (legacy_root / "examples/anypoint-spec.html").exists(), "legacy document example remains active beside the alias", failures)

    require("PDF_PAGE_LAYOUT" in formatter, "formatter does not own shared page geometry", failures)
    require("@page pdf-cover" in exporter, "exporter does not define a named full-bleed cover page", failures)
    require("page: pdf-cover" in exporter, "executive cover is not assigned to its named page", failures)
    require("preferCSSPageSize: true" in exporter, "exporter does not honor CSS-owned print geometry", failures)
    require("margin: { top:" not in exporter, "exporter still applies a global Playwright page margin", failures)
    require('"calendar"' in exporter and '"calendar-list"' in exporter and "pdf-calendar-list" in exporter, "exporter does not implement the shared monthly calendar semantics", failures)
    require("skills/pdf-artifact-generation/SKILL.md" in design_system, "design-system contract does not name the canonical PDF skill", failures)
    require("Full-bleed executive cover" in design_system, "design-system contract omits the full-bleed acceptance rule", failures)
    require("pdf-artifact-generation" in skill_index, "portable skill index does not expose PDF artifact generation", failures)
    require("pdf:table=calendar-list" in canonical, "canonical skill does not define the executive calendar-list semantic", failures)
    require("monthly-executive-report-cadence.md" in canonical, "canonical skill does not link the monthly cadence", failures)
    require("--month" in monthly_collector and "--person" in monthly_collector and "--timezone" in monthly_collector, "monthly collector is not parameterized by month, timezone, and contributor", failures)
    require("source_reference" in monthly_collector and "head_commit" in monthly_collector, "monthly collector does not preserve linked source evidence", failures)
    require("render_calendar" in monthly_calendar_renderer and "source_detail" in monthly_calendar_renderer, "monthly calendar renderer does not produce source-linked calendar details", failures)
    require("flush_inactive" in monthly_calendar_renderer and "No retrieved GitHub event" in monthly_calendar_renderer, "monthly calendar renderer leaves no-activity dates unexplained", failures)
    require("1,000-result cap" in monthly_collector, "monthly collector does not fail explicitly on GitHub Search truncation", failures)
    require("calendar" in monthly_cadence and "IANA" in monthly_cadence, "monthly cadence omits enforceable local-time calendar rules", failures)
    require("render_github_month_calendar.py" in monthly_cadence, "monthly cadence does not require source-generated contributor calendars", failures)
    require("pdf:table=calendar-list" in design_system, "design-system contract omits the executive calendar-list semantic", failures)

    if failures:
        print("PDF artifact contract failed:", file=sys.stderr)
        print("\n".join(f"- {failure}" for failure in failures), file=sys.stderr)
        return 1

    print("PDF artifact contract: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

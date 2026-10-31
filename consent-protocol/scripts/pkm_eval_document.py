"""Line coverage for a pasted context transfer, graded line by line.

Card counts said a section "worked" when eight cards came back, even when the
eight covered three of its twelve lines. This phase grades the question the
owner actually asks after pasting a document: is every line I wrote kept?

The document is the synthetic, founder-shaped fixture the web save-job tests
already replay (``hushh-webapp/__tests__/fixtures/pkm/context-transfer.v1.md``).
Every name, number and identifier in it is synthetic; no real founder content
is ever used here.

Each section is sent the way the device sends it (heading plus lines). When the
server answers ``split_recommended`` the batch is discarded and the passage is
halved, as the device's splitter does, until it fits.

Line labels come from the document's own structure, never from a model:

* ``memory``      a statement the owner wrote; it must be kept
* ``disclaimer``  a line under "Information not known"; it must never be saved
* ``duplicate``   a word-for-word repeat inside its section; either outcome is
                  allowed, and saving it twice is reported, not gated
* ``boilerplate`` the preamble that only says the document is synthetic
"""

from __future__ import annotations

import asyncio
import random
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from hushh_mcp.services.pkm_agent_lab_service import locate_source_quote
from scripts import pkm_eval_integrity as integrity

MONOREPO_ROOT = Path(__file__).resolve().parents[2]
DOCUMENT_PATH = (
    MONOREPO_ROOT / "hushh-webapp" / "__tests__" / "fixtures" / "pkm" / "context-transfer.v1.md"
)
DISCLAIMER_SECTIONS = frozenset({"Information not known"})
WRITE_ELIGIBLE = frozenset({"can_save", "confirm_first"})
DEFAULT_MIN_LINE_COVERAGE = 0.95
DOCUMENT_GATED_RATES = ("line_coverage_rate", "fallback_rate")
_PASSAGE_CONCURRENCY = 4


@dataclass(frozen=True)
class DocLine:
    index: int
    text: str
    section: str
    label: str


@dataclass(frozen=True)
class Passage:
    section: str
    heading: str | None
    lines: tuple[DocLine, ...]

    @property
    def message(self) -> str:
        body = [line.text for line in self.lines]
        return "\n".join([self.heading, *body] if self.heading else body)

    def halves(self) -> tuple[Passage, Passage]:
        middle = len(self.lines) // 2
        return (
            Passage(self.section, self.heading, self.lines[:middle]),
            Passage(self.section, self.heading, self.lines[middle:]),
        )


@dataclass(frozen=True)
class LineVerdict:
    index: int
    label: str
    kept: bool
    flag: str  # "" | "lost" | "disclaimer_saved"


@dataclass
class PassageOutcome:
    passage: Passage
    response: dict[str, Any]
    latency_ms: float
    timed_out: bool = False
    failure_class: str | None = None
    rep: int = 0
    splits: int = 0
    verdicts: list[LineVerdict] = field(default_factory=list)


def parse_document(text: str) -> list[Passage]:
    """One passage per section, each line labelled from the document's structure."""

    passages: list[Passage] = []
    section = ""
    heading: str | None = None
    lines: list[DocLine] = []
    seen: set[str] = set()

    def flush() -> None:
        if lines:
            passages.append(Passage(section, heading, tuple(lines)))

    for index, raw in enumerate(text.splitlines()):
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            flush()
            heading = raw
            section = stripped.lstrip("#").strip()
            lines = []
            seen = set()
            continue
        if not section:
            label = "boilerplate"
        elif section in DISCLAIMER_SECTIONS:
            label = "disclaimer"
        elif stripped in seen:
            label = "duplicate"
        else:
            label = "memory"
        seen.add(stripped)
        lines.append(DocLine(index, raw, section, label))
    flush()
    return passages


def score_passage(passage: Passage, response: dict[str, Any]) -> list[LineVerdict]:
    """Grade every line of one passage against the cards the server returned.

    A line is kept when a write-eligible card's quote maps onto any part of it.
    A quote that maps onto nothing keeps nothing: the server would have dropped
    it, so crediting it would count a rewrite as the owner's own words.
    """

    message = passage.message
    offsets: list[tuple[int, int]] = []
    cursor = len(passage.heading) + 1 if passage.heading else 0
    for line in passage.lines:
        offsets.append((cursor, cursor + len(line.text)))
        cursor += len(line.text) + 1
    spans = []
    for card in response.get("preview_cards") or []:
        if not isinstance(card, dict) or card.get("write_mode") not in WRITE_ELIGIBLE:
            continue
        span = locate_source_quote(message, str(card.get("source_text") or ""))
        if span is not None:
            spans.append(span)
    verdicts = []
    for line, (start, end) in zip(passage.lines, offsets, strict=True):
        kept = any(left < end and right > start for left, right in spans)
        flag = ""
        if line.label == "memory" and not kept:
            flag = "lost"
        elif line.label == "disclaimer" and kept:
            flag = "disclaimer_saved"
        verdicts.append(LineVerdict(line.index, line.label, kept, flag))
    return verdicts


def _flags(verdicts: list[LineVerdict]) -> set[str]:
    return {verdict.flag for verdict in verdicts if verdict.flag}


def _card(source_text: str, write_mode: str = "confirm_first") -> dict[str, Any]:
    return {"source_text": source_text, "write_mode": write_mode, "target_domain": "professional"}


def document_controls(
    passages: list[Passage], *, seed: int, rep: int
) -> list[tuple[integrity.Control, tuple[Passage, dict[str, Any]]]]:
    """Planted passages with known verdicts, built from the document itself."""

    rng = random.Random(f"{seed}:document:{rep}")  # noqa: S311 - seeded placement
    memory = [p for p in passages if any(line.label == "memory" for line in p.lines)]
    disclaimers = [p for p in passages if p.section in DISCLAIMER_SECTIONS]
    controls: list[tuple[integrity.Control, tuple[Passage, dict[str, Any]]]] = []
    if memory:
        passage = rng.choice(memory)
        keep = [line for line in passage.lines if line.label == "memory"]
        dropped = rng.choice(keep)
        cards = [_card(line.text) for line in keep if line is not dropped]
        cards.append(_card(dropped.text, "do_not_save"))
        controls.append(
            (
                integrity.Control("memory_line_not_saved", "catch", "lost"),
                (passage, {"preview_cards": cards}),
            )
        )
        passage = rng.choice(memory)
        keep = [line for line in passage.lines if line.label == "memory"]
        rewritten = rng.choice(keep)
        cards = [_card(line.text) for line in keep if line is not rewritten]
        cards.append(_card(f"The owner said: {rewritten.text.lstrip('- ')} (paraphrased)"))
        controls.append(
            (
                integrity.Control("quote_matches_no_line", "catch", "lost"),
                (passage, {"preview_cards": cards}),
            )
        )
        passage = rng.choice(memory)
        cards = [_card(line.text) for line in passage.lines if line.label == "memory"]
        controls.append(
            (integrity.Control("every_line_kept", "clean", ""), (passage, {"preview_cards": cards}))
        )
    if disclaimers:
        passage = disclaimers[0]
        controls.append(
            (
                integrity.Control("disclaimer_saved_as_fact", "catch", "disclaimer_saved"),
                (passage, {"preview_cards": [_card(passage.lines[0].text)]}),
            )
        )
        controls.append(
            (
                integrity.Control("disclaimers_left_unsaved", "clean", ""),
                (passage, {"preview_cards": []}),
            )
        )
    return controls


async def _answer_passage(
    *,
    service: Any,
    passage: Passage,
    model_override: str | None,
    strict_small_model: bool,
    timeout_seconds: float,
    rep: int,
) -> PassageOutcome:
    started = time.perf_counter()
    try:
        response = await asyncio.wait_for(
            service.generate_structure_preview(
                user_id="synthetic-context-transfer-owner",
                message=passage.message,
                current_domains=[],
                simulated_state=None,
                model_override=model_override,
                strict_small_model=strict_small_model,
                capture_execution_trace=True,
            ),
            timeout=timeout_seconds,
        )
        return PassageOutcome(
            passage, response, round((time.perf_counter() - started) * 1000, 2), rep=rep
        )
    except Exception as error:  # noqa: BLE001 - the class is recorded, the message never is
        return PassageOutcome(
            passage,
            {"preview_cards": [], "used_fallback": True, "validation_hints": []},
            round((time.perf_counter() - started) * 1000, 2),
            timed_out=isinstance(error, TimeoutError),
            failure_class=type(error).__name__,
            rep=rep,
        )


async def answer_document(
    *,
    service: Any,
    passages: list[Passage],
    model_override: str | None,
    strict_small_model: bool,
    timeout_seconds: float,
    rep: int,
) -> list[PassageOutcome]:
    """Send every section, halving any the server asks to split."""

    semaphore = asyncio.Semaphore(_PASSAGE_CONCURRENCY)

    async def send(passage: Passage, splits: int = 0) -> list[PassageOutcome]:
        async with semaphore:
            outcome = await _answer_passage(
                service=service,
                passage=passage,
                model_override=model_override,
                strict_small_model=strict_small_model,
                timeout_seconds=timeout_seconds,
                rep=rep,
            )
        split = "split_recommended" in (outcome.response.get("validation_hints") or [])
        if split and len(passage.lines) > 1:
            first, second = passage.halves()
            left, right = await asyncio.gather(send(first, splits + 1), send(second, splits + 1))
            return [*left, *right]
        outcome.splits = splits
        return [outcome]

    results = await asyncio.gather(*(send(passage) for passage in passages))
    return [outcome for group in results for outcome in group]


def summarize(outcomes: list[PassageOutcome]) -> dict[str, Any]:
    """Line-level rates for one repetition."""

    verdicts = [verdict for outcome in outcomes for verdict in outcome.verdicts]
    memory = [v for v in verdicts if v.label == "memory"]
    kept = sum(1 for v in memory if v.kept)
    cards = [
        card
        for outcome in outcomes
        for card in outcome.response.get("preview_cards") or []
        if isinstance(card, dict)
    ]
    eligible = [card for card in cards if card.get("write_mode") in WRITE_ELIGIBLE]
    by_section: dict[str, list[LineVerdict]] = {}
    for outcome in outcomes:
        by_section.setdefault(outcome.passage.section, []).extend(outcome.verdicts)
    return {
        "passages_sent": len(outcomes),
        "passages_split": sum(1 for outcome in outcomes if outcome.splits),
        "memory_lines": len(memory),
        "memory_lines_kept": kept,
        "line_coverage_rate": round(kept / len(memory), 4) if memory else None,
        "lost_line_indexes": [v.index for v in memory if not v.kept],
        "disclaimer_saved_count": sum(1 for v in verdicts if v.flag == "disclaimer_saved"),
        "duplicate_saved_count": sum(1 for v in verdicts if v.label == "duplicate" and v.kept),
        "cards_returned": len(cards),
        "cards_write_eligible": len(eligible),
        "card_domain_counts": dict(Counter(str(card.get("target_domain")) for card in eligible)),
        "fallback_rate": round(
            sum(1 for o in outcomes if o.response.get("used_fallback")) / len(outcomes), 4
        )
        if outcomes
        else None,
        "timeout_count": sum(1 for outcome in outcomes if outcome.timed_out),
        "error_count": sum(
            1 for outcome in outcomes if outcome.failure_class and not outcome.timed_out
        ),
        "section_coverage": {
            section: {
                "memory_lines": sum(1 for v in rows if v.label == "memory"),
                "kept": sum(1 for v in rows if v.label == "memory" and v.kept),
            }
            for section, rows in by_section.items()
        },
        "average_passage_latency_ms": round(
            sum(outcome.latency_ms for outcome in outcomes) / len(outcomes), 2
        )
        if outcomes
        else None,
    }


async def run_document_mode(
    *,
    service: Any,
    document_path: Path,
    model_override: str | None,
    strict_small_model: bool,
    timeout_seconds: float,
    reps: int,
    control_seed: int,
) -> dict[str, Any]:
    passages = parse_document(document_path.read_text(encoding="utf-8"))
    outcomes: list[PassageOutcome] = []
    with integrity.count_provider_refusals() as refusals:
        for rep in range(max(1, reps)):
            outcomes.extend(
                await answer_document(
                    service=service,
                    passages=passages,
                    model_override=model_override,
                    strict_small_model=strict_small_model,
                    timeout_seconds=timeout_seconds,
                    rep=rep,
                )
            )
    planted = [
        control
        for rep in range(max(1, reps))
        for control in document_controls(passages, seed=control_seed, rep=rep)
    ]
    real_rows = [(outcome.passage, outcome.response) for outcome in outcomes]
    graded, key = integrity.plant(real_rows, planted, seed=control_seed)
    verdict_rows = [score_passage(passage, response) for passage, response in graded]
    void_reasons, control_summary = integrity.check_controls(verdict_rows, key, flags=_flags)
    void_reasons += integrity.provider_void_reasons(refusals.count)
    by_row = {id(row): verdicts for row, verdicts in zip(graded, verdict_rows, strict=True)}
    for outcome, row in zip(outcomes, real_rows, strict=True):
        outcome.verdicts = by_row[id(row)]
    per_rep = [summarize([o for o in outcomes if o.rep == rep]) for rep in range(max(1, reps))]
    rep_stats = integrity.rep_statistics(per_rep, DOCUMENT_GATED_RATES)
    lines = {line.index: line for passage in passages for line in passage.lines}
    lost = Counter(index for entry in per_rep for index in entry["lost_line_indexes"])
    report = {
        "document": str(document_path.relative_to(MONOREPO_ROOT))
        if document_path.is_relative_to(MONOREPO_ROOT)
        else document_path.name,
        "sections": len(passages),
        "line_labels": dict(Counter(line.label for line in lines.values())),
        "reps": max(1, reps),
        "control_seed": control_seed,
        "controls": control_summary,
        "void": bool(void_reasons),
        "void_reasons": void_reasons,
        "provider_refused_calls": refusals.count,
        "rep_summaries": per_rep,
        "rep_statistics": rep_stats,
        "lost_lines": [
            {
                "line": index + 1,
                "section": lines[index].section,
                "lost_in_reps": count,
                "text": lines[index].text[:160],
            }
            for index, count in sorted(lost.items())
        ],
        "outcomes": [
            {
                "rep": outcome.rep,
                "section": outcome.passage.section,
                "lines": [line.index + 1 for line in outcome.passage.lines],
                "splits": outcome.splits,
                "latency_ms": outcome.latency_ms,
                "timed_out": outcome.timed_out,
                "failure_class": outcome.failure_class,
                "used_fallback": bool(outcome.response.get("used_fallback")),
                "verdicts": [asdict(verdict) for verdict in outcome.verdicts],
                "cards": [
                    {
                        key_: card.get(key_)
                        for key_ in (
                            "source_text",
                            "write_mode",
                            "target_domain",
                            "intent_class",
                            "save_class",
                        )
                    }
                    for card in outcome.response.get("preview_cards") or []
                    if isinstance(card, dict)
                ],
            }
            for outcome in outcomes
        ],
    }
    if void_reasons:
        report["rep_summaries"] = [integrity.void_rates(entry) for entry in per_rep]
        report["rep_statistics"] = {}
    return report


def gate_failures(
    report: dict[str, Any], *, min_line_coverage: float, max_fallback: float, max_spread: float
) -> list[str]:
    label = "document"
    if report.get("void"):
        return [f"{label}:void:{reason}" for reason in report.get("void_reasons") or []]
    failures = integrity.variance_failures(
        label=label,
        stats=report.get("rep_statistics") or {},
        reps=int(report.get("reps") or 0),
        max_spread=max_spread,
    )
    stats = report.get("rep_statistics") or {}
    coverage = (stats.get("line_coverage_rate") or {}).get("mean")
    if coverage is None or coverage < min_line_coverage:
        failures.append(f"{label}:line_coverage {coverage} < {min_line_coverage:.4f}")
    fallback = (stats.get("fallback_rate") or {}).get("mean")
    if fallback is None or fallback > max_fallback:
        failures.append(f"{label}:fallback {fallback} > {max_fallback:.4f}")
    for entry in report.get("rep_summaries") or []:
        for key, name in (
            ("disclaimer_saved_count", "disclaimer_saved"),
            ("timeout_count", "outer_timeout"),
            ("error_count", "outer_error"),
        ):
            if int(entry.get(key) or 0) > 0:
                failures.append(f"{label}:{name} {entry[key]}")
    return failures

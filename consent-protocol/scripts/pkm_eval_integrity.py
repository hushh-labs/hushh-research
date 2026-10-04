"""Integrity rules for the PKM memory-agent evaluation.

The structure-agent eval used to publish one run's rates as if they were the
agents' accuracy. This module holds the rules that make a published number
mean something, lifted from the judging contract the puppy-one harness already
enforces (``.codex/skills/puppy-one-harness/references/judging-contract.md``):

* The judge is never the answerer. Gemini answers; a deterministic scorer
  grades. Planted controls prove the scorer reads.
* Planted controls are unmarked. A control row reaches the scorer through the
  same function as every real row, in a seeded random position, and its answer
  key never does. A negative control graded clean, or a positive control
  flagged, voids the run.
* A void run publishes no accuracy at all, not a number with a caveat.
* ``unsure`` counts against accuracy. A stage that fell back to a non-model
  answer is not a correct answer, even when the fallback guessed right.
* Variance is measured, not assumed: at least three repetitions, the mean and
  the spread of every gated rate, and a gate on the spread.
* Runs are comparable only when their capability profile matches (model id,
  thinking level per agent, runtime adapter, prompt path, SDK versions). The
  instructions under test are the subject, recorded separately, because they
  are exactly what a comparison is meant to vary.
* A run in which the provider refused a stage call (quota, rate limit, outage)
  is void: those cases were graded wrong for a reason outside the subject.
* Every run lands in an append-only, hash-chained ledger, void runs included.
"""

from __future__ import annotations

import fcntl
import hashlib
import importlib.metadata
import json
import logging
import math
import random
import re
import subprocess
import time
from collections.abc import Callable, Iterable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

LEDGER_SCHEMA = "pkm-structure-agent-ledger.v1"
CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LEDGER_PATH = (
    CONSENT_PROTOCOL_ROOT / "artifacts" / "pkm-structure-agent" / "ledger.v1.jsonl"
)
MIN_GATED_REPS = 3
# One case of the 24-case release chain moves a rate by 0.0417, so 0.10 allows
# two cases to flip between repetitions and no more.
DEFAULT_MAX_RATE_SPREAD = 0.10
# Rates gated at a minimum (higher is better) and at a maximum (lower is better).
MINIMUM_RATES = (
    "schema_ok_rate",
    "intent_ok_rate",
    "mutation_ok_rate",
    "domain_ok_rate",
    "durable_domain_coverage_rate",
)
MAXIMUM_RATES = ("fallback_rate",)
CASE_GATED_RATES = (*MINIMUM_RATES, *MAXIMUM_RATES)


# --------------------------------------------------------------------------
# Repetition statistics
# --------------------------------------------------------------------------


def rep_statistics(per_rep: Sequence[dict[str, Any]], metrics: Iterable[str]) -> dict[str, Any]:
    """Mean and spread of each metric across repetitions.

    ``spread`` is max minus min, the honest worst case a reader should expect
    between two runs. ``stdev`` is the sample standard deviation and is null
    below two samples, because one sample has no deviation to report.
    """

    stats: dict[str, Any] = {}
    for metric in metrics:
        values = [float(rep[metric]) for rep in per_rep if rep.get(metric) is not None]
        if not values:
            stats[metric] = {
                "n": 0,
                "mean": None,
                "min": None,
                "max": None,
                "spread": None,
                "stdev": None,
                "per_rep": [],
            }
            continue
        mean = sum(values) / len(values)
        stdev = (
            math.sqrt(sum((value - mean) ** 2 for value in values) / (len(values) - 1))
            if len(values) > 1
            else None
        )
        stats[metric] = {
            "n": len(values),
            "mean": round(mean, 4),
            "min": round(min(values), 4),
            "max": round(max(values), 4),
            "spread": round(max(values) - min(values), 4),
            "stdev": round(stdev, 4) if stdev is not None else None,
            "per_rep": [round(value, 4) for value in values],
        }
    return stats


def variance_failures(
    *,
    label: str,
    stats: dict[str, Any],
    reps: int,
    max_spread: float,
    min_reps: int = MIN_GATED_REPS,
) -> list[str]:
    """Gate failures for an unmeasured or unstable rate.

    Fewer than ``min_reps`` repetitions is a failure, not a pass: one run says
    nothing about the next one, and a gate that passes on n=1 is a coin toss
    reported as a measurement.
    """

    if reps < min_reps:
        return [f"{label}:variance_unmeasured n={reps} < {min_reps}"]
    failures = []
    for metric, entry in stats.items():
        spread = entry.get("spread")
        if spread is None:
            failures.append(f"{label}:{metric} spread not measured")
        elif float(spread) > max_spread:
            failures.append(f"{label}:{metric} spread {float(spread):.4f} > {max_spread:.4f}")
    return failures


# --------------------------------------------------------------------------
# Planted controls
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Control:
    """One planted row. ``expect`` is the answer key: catch or clean."""

    kind: str
    expect: str  # "catch": the scorer must flag ``field``; "clean": it must flag nothing
    field: str


def plant(
    real_rows: Sequence[Any],
    control_rows: Sequence[tuple[Control, Any]],
    *,
    seed: int,
) -> tuple[list[Any], dict[int, Control]]:
    """Interleave controls among real rows at seeded random positions.

    Returns the rows in grading order and the answer key, keyed by position.
    The key stays with the harness; the scorer receives only rows.
    """

    rows: list[tuple[Control | None, Any]] = [(None, row) for row in real_rows]
    rows.extend(control_rows)
    order = list(range(len(rows)))
    random.Random(seed).shuffle(order)  # noqa: S311 - seeded placement, not secrecy
    graded = [rows[index][1] for index in order]
    key = {
        position: control
        for position, index in enumerate(order)
        if (control := rows[index][0]) is not None
    }
    return graded, key


def check_controls(
    verdicts: Sequence[Any],
    key: dict[int, Control],
    *,
    flags: Callable[[Any], set[str]],
) -> tuple[list[str], dict[str, Any]]:
    """Void reasons for every control the scorer graded wrong.

    ``flags(verdict)`` returns the set of gated fields the scorer marked wrong
    for one row. A negative control must carry its planted field; a positive
    control must carry none.
    """

    reasons: list[str] = []
    caught = clean = 0
    for position, control in sorted(key.items()):
        marked = flags(verdicts[position])
        if control.expect == "catch":
            if control.field in marked:
                caught += 1
            else:
                reasons.append(f"negative control passed: {control.kind} ({control.field})")
        elif marked:
            reasons.append(
                f"positive control flagged: {control.kind} ({', '.join(sorted(marked))})"
            )
        else:
            clean += 1
    negatives = sum(1 for control in key.values() if control.expect == "catch")
    summary = {
        "planted": len(key),
        "negative": negatives,
        "negative_caught": caught,
        "positive": len(key) - negatives,
        "positive_clean": clean,
        "kinds": sorted({control.kind for control in key.values()}),
    }
    return reasons, summary


def void_rates(summary: dict[str, Any]) -> dict[str, Any]:
    """The summary of a void run: every accuracy rate withheld."""

    return {key: (None if key.endswith("_rate") else value) for key, value in summary.items()}


# --------------------------------------------------------------------------
# Provider refusals
# --------------------------------------------------------------------------

# 429 is quota or rate limiting; 5xx is a provider outage. A 4xx other than 429
# can be our own malformed request, which is the subject's failure, not void.
PROVIDER_REFUSAL_STATUSES = frozenset({429, 500, 502, 503, 504})
_SERVICE_LOGGER = "hushh_mcp.services.pkm_agent_lab_service"
_FAILED_STAGE_LOG = "pkm.agent_contract_failed"
_PROVIDER_STATUS = re.compile(r"provider_status=(\d+)")


class ProviderRefusalCounter(logging.Handler):
    """Count stage calls the provider refused, from the service's own log line.

    Both the baseline and the head log ``pkm.agent_contract_failed ...
    provider_status=N`` when a stage gives up, so counting needs no change to
    either version under test.
    """

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.count = 0

    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        if _FAILED_STAGE_LOG not in message:
            return
        match = _PROVIDER_STATUS.search(message)
        if match and int(match.group(1)) in PROVIDER_REFUSAL_STATUSES:
            self.count += 1


@contextmanager
def count_provider_refusals(logger_name: str = _SERVICE_LOGGER) -> Iterator[ProviderRefusalCounter]:
    counter = ProviderRefusalCounter()
    logger = logging.getLogger(logger_name)
    logger.addHandler(counter)
    try:
        yield counter
    finally:
        logger.removeHandler(counter)


def provider_void_reasons(refused: int) -> list[str]:
    if not refused:
        return []
    return [
        f"provider refused {refused} stage call(s) (quota, rate limit, or outage): "
        "the run did not measure the instructions"
    ]


# --------------------------------------------------------------------------
# Capability profile and subject
# --------------------------------------------------------------------------


def _package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "not-installed"


def _effective_thinking_level(model: str, level: str | None) -> str | None:
    """The level the provider receives, after the shared compatibility rules."""

    from hushh_mcp.runtime_providers.gemini_config import thinking_config_for

    types_stub = SimpleNamespace(ThinkingLevel=None, ThinkingConfig=SimpleNamespace)
    config = thinking_config_for(model, level, types_stub)
    return None if config is None else str(config.thinking_level).lower()


def _manifest_runtime(manifest: Any, model_override: str | None) -> dict[str, Any]:
    from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name

    resolver = getattr(manifest, "model_config_for_runtime", None)
    config = resolver() if callable(resolver) else None
    model = resolve_fleet_model_name(model_override or getattr(config, "name", None))
    level = getattr(config, "thinking_level", None)
    return {"model": model, "thinking_level": _effective_thinking_level(model, level)}


def memory_agent_manifests(service: Any) -> dict[str, Any]:
    names = (
        "memory_segmentation_manifest",
        "memory_intent_manifest",
        "memory_merge_manifest",
        "structure_manifest",
    )
    manifests = {}
    for name in names:
        manifest = getattr(service, name, None)
        if manifest is not None:
            manifests[str(getattr(manifest, "id", name))] = manifest
    return manifests


def capability_profile(
    *, service: Any, model_override: str | None, strict_small_model: bool
) -> dict[str, Any]:
    """What the model was asked to be, independent of the instructions under test.

    Two runs whose profiles differ were not asked the same question, so a delta
    between them is invented rather than measured.
    """

    agents = {
        agent_id: _manifest_runtime(manifest, model_override)
        for agent_id, manifest in memory_agent_manifests(service).items()
    }
    adapter = "unknown"
    should_use_adk = getattr(service, "_should_use_adk_single_turn", None)
    manifests = list(memory_agent_manifests(service).values())
    if callable(should_use_adk) and manifests:
        adapter = "adk_single_turn" if should_use_adk(manifests[0]) else "direct_client"
    return {
        "agents": agents,
        "runtime_adapter": adapter,
        "prompt_path": "strict_small_model" if strict_small_model else "production",
        "google_genai": _package_version("google-genai"),
        "google_adk": _package_version("google-adk"),
    }


def subject_fingerprint(service: Any) -> dict[str, Any]:
    """The instructions under test: what a comparison is meant to vary."""

    fingerprint: dict[str, Any] = {}
    for agent_id, manifest in memory_agent_manifests(service).items():
        instruction = str(getattr(manifest, "system_instruction", "") or "")
        fingerprint[agent_id] = {
            "system_instruction_sha256": hashlib.sha256(instruction.encode()).hexdigest(),
            "system_instruction_chars": len(instruction),
            "prompt_reference": getattr(manifest, "prompt_reference", None),
        }
    return fingerprint


def profile_differences(left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    """Every field on which two capability profiles disagree."""

    differences: list[str] = []

    def walk(a: Any, b: Any, path: str) -> None:
        if isinstance(a, dict) and isinstance(b, dict):
            for key in sorted(set(a) | set(b)):
                walk(a.get(key), b.get(key), f"{path}.{key}" if path else key)
        elif a != b:
            differences.append(f"{path}: {a!r} != {b!r}")

    walk(left, right, "")
    return differences


# --------------------------------------------------------------------------
# Append-only ledger
# --------------------------------------------------------------------------


class IncomparableRunsError(ValueError):
    """Raised instead of producing a delta between different capability profiles."""


def _canonical(entry: dict[str, Any]) -> str:
    return json.dumps(entry, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _entry_digest(entry: dict[str, Any]) -> str:
    body = {key: value for key, value in entry.items() if key != "entry_sha256"}
    return hashlib.sha256(_canonical(body).encode()).hexdigest()


def git_state(root: Path = CONSENT_PROTOCOL_ROOT) -> dict[str, Any]:
    def run(*args: str) -> str:
        try:
            return subprocess.run(  # noqa: S603 - fixed git arguments, no shell
                ["git", *args], cwd=root, capture_output=True, text=True, check=False, timeout=10
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ""

    # Scoped to the code under test (this tree) and blind to the ledger itself,
    # which every run modifies. Other paths' uncommitted work is not the subject;
    # what is dirty here is listed, so a reader sees exactly what differed.
    status = run("status", "--porcelain", "--", ".", ":(exclude)artifacts/pkm-structure-agent")
    # run() strips the output, which eats the first line's leading status
    # column, so slice past the two-character status and strip the rest.
    dirty_paths = sorted(line[2:].strip() for line in status.splitlines() if len(line) > 3)
    return {
        "sha": run("rev-parse", "HEAD") or "unknown",
        "dirty": bool(dirty_paths),
        "dirty_paths": dirty_paths[:20],
    }


def read_ledger(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def verify_ledger(path: Path) -> list[str]:
    """Every break in the ledger's sequence or hash chain.

    Rewriting an earlier entry changes its digest and breaks every link after
    it, so an edit is detectable even though the file itself is writable.
    """

    errors: list[str] = []
    previous = None
    for index, entry in enumerate(read_ledger(path)):
        if entry.get("schema") != LEDGER_SCHEMA:
            errors.append(f"entry {index}: unknown schema {entry.get('schema')!r}")
        if entry.get("seq") != index:
            errors.append(f"entry {index}: seq {entry.get('seq')!r} out of order")
        if entry.get("prev_sha256") != previous:
            errors.append(f"entry {index}: prev_sha256 does not chain")
        if entry.get("entry_sha256") != _entry_digest(entry):
            errors.append(f"entry {index}: entry_sha256 does not match its content")
        previous = entry.get("entry_sha256")
    return errors


def append_ledger(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    """Append one run under an exclusive lock, chained to the previous entry."""

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            handle.seek(0)
            lines = [line for line in handle.read().splitlines() if line]
            previous = json.loads(lines[-1]) if lines else None
            entry = {
                "schema": LEDGER_SCHEMA,
                "seq": len(lines),
                "prev_sha256": previous.get("entry_sha256") if previous else None,
                "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                **record,
            }
            entry["entry_sha256"] = _entry_digest(entry)
            handle.seek(0, 2)
            handle.write(_canonical(entry) + "\n")
            handle.flush()
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
    return entry


def compare_entries(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    """Per-metric deltas between two ledger entries of the same phase and profile.

    Refuses rather than producing a trend nobody can invalidate: a void run has
    no accuracy to compare, and a different capability profile was a different
    question.
    """

    if left.get("phase") != right.get("phase"):
        raise IncomparableRunsError(
            f"different phases: {left.get('phase')!r} != {right.get('phase')!r}"
        )
    for entry in (left, right):
        if entry.get("status") == "void":
            raise IncomparableRunsError(f"entry {entry.get('seq')} is void and publishes no rates")
    differences = profile_differences(
        left.get("capability_profile") or {}, right.get("capability_profile") or {}
    )
    if differences:
        raise IncomparableRunsError("capability profiles differ: " + "; ".join(differences))
    deltas = {}
    for metric, entry in (right.get("rates") or {}).items():
        before = (left.get("rates") or {}).get(metric) or {}
        if entry.get("mean") is None or before.get("mean") is None:
            continue
        deltas[metric] = {
            "before": f"{before['mean']:.4f} ± {before.get('spread') or 0:.4f} (n={before['n']})",
            "after": f"{entry['mean']:.4f} ± {entry.get('spread') or 0:.4f} (n={entry['n']})",
            "delta_mean": round(entry["mean"] - before["mean"], 4),
        }
    return {
        "phase": right.get("phase"),
        "before_seq": left.get("seq"),
        "after_seq": right.get("seq"),
        "deltas": deltas,
    }

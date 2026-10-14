#!/usr/bin/env python3
"""Ratchet declared Live Memory inventory source kinds against runtime registration."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONTRACT = Path("docs/reference/architecture/live-memory-source-contract.md")
RECORDS = Path("hushh-webapp/lib/pkm/living-source-records.ts")
SYNC = Path("hushh-webapp/lib/pkm/living-source-sync.ts")
START = "<!-- live-memory-source-contract:v1 -->"
END = "<!-- /live-memory-source-contract:v1 -->"
PR_IMPACT_START = "- Live Memory source impact (every feature):"
PR_IMPACT_END = "- Mobile parity impacts:"
PR_IMPACT_CHOICES = (
    "No durable owner data is created, changed, or deleted",
    "Existing admitted source covers the data",
    "New source is declared",
    "Data should remain outside Live Memory",
)
REQUIRED_TEXT = (
    "authority",
    "owner_isolation",
    "revision",
    "tombstone",
    "freshness_errors",
    "exposure",
    "retention",
)
REQUIRED_REFERENCE = ("signal", "snapshot")
REQUIRED_LIST = ("fields", "exclusions", "evidence")
LEGACY_UNBOUNDED: set[str] = set()
RUNTIME_ROOTS = ("hushh-webapp", "consent-protocol")
RUNTIME_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".py"}
EXCLUDED_RUNTIME_PARTS = {"__tests__", "tests", "e2e", "node_modules", ".next", "__pycache__"}
SOURCE_REFERENCE_PATTERN = re.compile(
    r"\b(?:one_living_sources|owner_source_projection|one_living_memory_source_projection|LIVING_SOURCE_DOMAIN)\b"
)
# Any new reference to this owner-only domain requires review, even if it
# reuses an existing source kind. Only the three PKM call sites may initiate a
# projection write. Framework calls remain counted to detect a new path there.
SOURCE_REFERENCE_ALLOWLIST = {
    "consent-protocol/hushh_mcp/services/domain_contracts.py",
    "consent-protocol/hushh_mcp/services/pkm_mutation_contracts.py",
    "hushh-webapp/components/consent/answer-request-review.tsx",
    "hushh-webapp/components/profile/living-memory-bridge.tsx",
    "hushh-webapp/lib/consent/pkm-scope-policy.ts",
    "hushh-webapp/lib/personal-knowledge-model/mutation-plan.ts",
    "hushh-webapp/lib/pkm/living-source-sync.ts",
    "hushh-webapp/lib/pkm/memory-complete-rows.ts",
    "hushh-webapp/lib/pkm/memory-document-store.ts",
    "hushh-webapp/lib/pkm/memory-refresh.ts",
    "hushh-webapp/lib/services/personal-knowledge-model-service.ts",
    "hushh-webapp/lib/services/pkm-write-coordinator.ts",
}
MUTATION_CALL_PATTERN = re.compile(
    r"\.\s*(?:saveMergedDomain|savePreparedDomain|storeDomainData|storeMergedDomain|"
    r"storeMergedDomainWithPreparedBlob|storePreparedDomain|storePreparedDomainWithPreparedBlob|storeWalletDomain)\s*\("
)
MUTATION_CALL_ALLOWLIST = {
    "hushh-webapp/lib/pkm/living-source-sync.ts": 1,
    "hushh-webapp/lib/pkm/memory-document-store.ts": 1,
    "hushh-webapp/lib/pkm/memory-refresh.ts": 1,
    # Generic coordinator internals call the PKM store for all domains.
    "hushh-webapp/lib/services/pkm-write-coordinator.ts": 2,
    # Internal generic data-store dispatches are counted too.
    "hushh-webapp/lib/services/personal-knowledge-model-service.ts": 8,
}


def parse_contract(markdown: str) -> list[dict]:
    if markdown.count(START) != 1 or markdown.count(END) != 1:
        raise ValueError("expected exactly one marked source-contract block")
    body = markdown.split(START, 1)[1].split(END, 1)[0].strip()
    match = re.fullmatch(r"```json\s*\n(.*?)\n```", body, re.DOTALL)
    if not match:
        raise ValueError("source-contract block must be one JSON code fence")
    manifest = json.loads(match.group(1))
    if not isinstance(manifest, dict) or set(manifest) != {"sources"}:
        raise ValueError("source contract must have only a sources array")
    sources = manifest["sources"]
    if not isinstance(sources, list) or not sources:
        raise ValueError("sources must be a nonempty array")
    return sources


def validate_pr_impact(body: str) -> None:
    if PR_IMPACT_START not in body or PR_IMPACT_END not in body:
        raise ValueError("PR body needs the Live Memory source impact section")
    section = body.split(PR_IMPACT_START, 1)[1].split(PR_IMPACT_END, 1)[0]
    checked = re.findall(r"^\s*-\s*\[[xX]\]\s*(.+)$", section, re.MULTILINE)
    choices = [item for item in checked if any(item.startswith(choice) for choice in PR_IMPACT_CHOICES)]
    if len(choices) != 1 or len(checked) != 1:
        raise ValueError("PR body must check exactly one Live Memory impact choice")
    evidence = re.search(
        r"^\s*-\s*Live Memory evidence \(source kind and test, or no-impact reason\):\s*(\S.*)$",
        section,
        re.MULTILINE,
    )
    if not evidence:
        raise ValueError("PR body needs concrete Live Memory impact evidence")


def validate_pr_event() -> None:
    if os.environ.get("GITHUB_EVENT_NAME") != "pull_request":
        return
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path:
        raise ValueError("pull_request event path is unavailable")
    event = json.loads(Path(event_path).read_text(encoding="utf-8"))
    body = event.get("pull_request", {}).get("body")
    if not isinstance(body, str):
        raise ValueError("pull_request body is unavailable")
    validate_pr_impact(body)


def registered_kinds(records_code: str, sync_code: str) -> tuple[set[str], set[str]]:
    match = re.search(r"export interface LivingSourceInput\s*\{[^}]*?\bkind:\s*([^;]+);", records_code, re.DOTALL)
    if not match:
        raise ValueError("cannot locate LivingSourceInput.kind registration union")
    union = match.group(1).strip()
    if not re.fullmatch(r'"[a-z][a-z0-9_]*"(?:\s*\|\s*"[a-z][a-z0-9_]*")*', union):
        raise ValueError("LivingSourceInput.kind must remain a static literal union")
    typed = set(re.findall(r'"([a-z][a-z0-9_]*)"', union))
    emitted = set(re.findall(r'\bkind:\s*"([a-z][a-z0-9_]*)"', sync_code))
    if typed != emitted:
        raise ValueError(f"typed and emitted source kinds differ: type={sorted(typed)}, emitted={sorted(emitted)}")
    return typed, emitted


def nonempty_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a nonempty string")
    return value


def repository_reference(root: Path, path_value: object, anchor: object, label: str) -> None:
    path = nonempty_string(path_value, f"{label}.path")
    needle = nonempty_string(anchor, f"{label}.anchor")
    relative = Path(path)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"{label}.path must stay within the repository")
    candidate = root / relative
    if not candidate.is_file():
        raise ValueError(f"{label}.path does not exist: {path}")
    if needle not in candidate.read_text(encoding="utf-8"):
        raise ValueError(f"{label}.anchor is absent from {path}: {needle!r}")


def runtime_sources(root: Path) -> dict[str, str]:
    sources: dict[str, str] = {}
    for directory in RUNTIME_ROOTS:
        for parent, children, files in os.walk(root / directory):
            children[:] = [name for name in children if name not in EXCLUDED_RUNTIME_PARTS and not name.startswith(".")]
            for name in files:
                path = Path(parent) / name
                if path.suffix not in RUNTIME_SUFFIXES:
                    continue
                sources[path.relative_to(root).as_posix()] = path.read_text(encoding="utf-8")
    return sources


def validate_writer_call_sites(sources: dict[str, str]) -> None:
    references = {path for path, code in sources.items() if SOURCE_REFERENCE_PATTERN.search(code)}
    unknown = references - SOURCE_REFERENCE_ALLOWLIST
    missing = SOURCE_REFERENCE_ALLOWLIST - references
    if unknown or missing:
        raise ValueError(f"owner projection runtime references changed: new={sorted(unknown)}, missing={sorted(missing)}")
    for path in sorted(references):
        count = len(MUTATION_CALL_PATTERN.findall(sources[path]))
        expected = MUTATION_CALL_ALLOWLIST.get(path, 0)
        if count != expected:
            raise ValueError(f"owner projection mutation call sites changed: {path} has {count}, expected {expected}")


def validate(root: Path, sources: list[dict], records_code: str, sync_code: str) -> None:
    typed, _ = registered_kinds(records_code, sync_code)
    kinds: list[str] = []
    for source in sources:
        if not isinstance(source, dict):
            raise ValueError("every source declaration must be an object")
        kind = nonempty_string(source.get("kind"), "source.kind")
        if not re.fullmatch(r"[a-z][a-z0-9_]*", kind):
            raise ValueError(f"invalid source kind: {kind}")
        kinds.append(kind)
        for field in REQUIRED_TEXT:
            nonempty_string(source.get(field), f"{kind}.{field}")
        for field in REQUIRED_LIST:
            items = source.get(field)
            if not isinstance(items, list) or not items:
                raise ValueError(f"{kind}.{field} must be a nonempty array")
            for item in items:
                nonempty_string(item, f"{kind}.{field} item")
        capacity = source.get("capacity")
        if not isinstance(capacity, dict):
            raise ValueError(f"{kind}.capacity must declare a bounded record policy")
        mode = capacity.get("mode")
        if mode == "bounded":
            maximum = capacity.get("max_records")
            if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum < 1:
                raise ValueError(f"{kind}.capacity.max_records must be a positive integer")
            nonempty_string(capacity.get("overflow"), f"{kind}.capacity.overflow")
            repository_reference(root, capacity.get("path"), capacity.get("anchor"), f"{kind}.capacity")
            if kind != "profile":
                symbol = nonempty_string(capacity.get("limit_symbol"), f"{kind}.capacity.limit_symbol")
                if not re.fullmatch(r"[A-Z][A-Z0-9_]*", symbol):
                    raise ValueError(f"{kind}.capacity.limit_symbol must name a numeric constant")
                capacity_code = (root / capacity["path"]).read_text(encoding="utf-8")
                match = re.search(rf"\bconst\s+{re.escape(symbol)}\s*=\s*([0-9][0-9_]*)\s*;", capacity_code)
                if not match or int(match.group(1).replace("_", "")) != maximum or symbol not in capacity["anchor"]:
                    raise ValueError(f"{kind}.capacity.max_records must match the referenced runtime guard")
                retained = capacity.get("max_retained_records")
                if isinstance(retained, bool) or not isinstance(retained, int) or retained < maximum:
                    raise ValueError(f"{kind}.capacity.max_retained_records must cover the active scan")
                retained_symbol = nonempty_string(capacity.get("retained_limit_symbol"), f"{kind}.capacity.retained_limit_symbol")
                retained_anchor = nonempty_string(capacity.get("retained_anchor"), f"{kind}.capacity.retained_anchor")
                if not re.fullmatch(r"[A-Z][A-Z0-9_]*", retained_symbol):
                    raise ValueError(f"{kind}.capacity.retained_limit_symbol must name a numeric constant")
                repository_reference(root, capacity["path"], retained_anchor, f"{kind}.capacity.retained")
                retained_match = re.search(rf"\bconst\s+{re.escape(retained_symbol)}\s*=\s*([0-9][0-9_]*)\s*;", capacity_code)
                if not retained_match or int(retained_match.group(1).replace("_", "")) != retained or retained_symbol not in retained_anchor:
                    raise ValueError(f"{kind}.capacity.max_retained_records must match the referenced runtime guard")
        elif mode == "legacy_unbounded" and kind in LEGACY_UNBOUNDED:
            nonempty_string(capacity.get("risk"), f"{kind}.capacity.risk")
        else:
            raise ValueError(f"{kind}.capacity must be bounded; only {sorted(LEGACY_UNBOUNDED)} have a legacy exception")
        repository_reference(root, source.get("source_file"), source.get("source_anchor"), f"{kind}.source")
        if source["source_file"] != SYNC.as_posix() or source["source_anchor"] != f'kind: "{kind}"':
            raise ValueError(f"{kind} must reference its literal source emission in {SYNC}")
        for field in REQUIRED_REFERENCE:
            ref = source.get(field)
            if not isinstance(ref, dict):
                raise ValueError(f"{kind}.{field} must declare path, anchor, and rule")
            repository_reference(root, ref.get("path"), ref.get("anchor"), f"{kind}.{field}")
            nonempty_string(ref.get("rule"), f"{kind}.{field}.rule")
        for evidence in source["evidence"]:
            relative = Path(evidence)
            if relative.is_absolute() or ".." in relative.parts or not (root / relative).is_file():
                raise ValueError(f"{kind}.evidence does not exist within repository: {evidence}")
            if not relative.name.endswith((".test.ts", ".test.tsx", ".test.py")):
                raise ValueError(f"{kind}.evidence must be a focused test: {evidence}")
    if len(kinds) != len(set(kinds)):
        raise ValueError("duplicate source kind declaration")
    if set(kinds) != typed:
        raise ValueError(f"source declaration differs from registered kinds: declared={sorted(kinds)}, registered={sorted(typed)}")


def self_test(root: Path, sources: list[dict], records_code: str, sync_code: str, code: dict[str, str]) -> None:
    validate(root, sources, records_code, sync_code)
    validate_writer_call_sites(code)
    valid_pr = "\n".join((PR_IMPACT_START,
        "  - [x] Existing admitted source covers the data; kind, change signal, and focused test listed below",
        "  - Live Memory evidence (source kind and test, or no-impact reason): profile; identity change; profile sync test",
        PR_IMPACT_END))
    validate_pr_impact(valid_pr)
    for invalid in (valid_pr.replace("[x]", "[ ]"),
                    valid_pr.replace("profile; identity change; profile sync test", ""),
                    valid_pr.replace(PR_IMPACT_START, "")):
        try:
            validate_pr_impact(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("incomplete PR Live Memory impact passed")
    absent = [dict(source) for source in sources[:-1]]
    try:
        validate(root, absent, records_code, sync_code)
    except ValueError as error:
        assert "differs from registered kinds" in str(error)
    else:
        raise AssertionError("missing declaration passed")
    changed = [dict(source) for source in sources]
    changed[0]["owner_isolation"] = ""
    try:
        validate(root, changed, records_code, sync_code)
    except ValueError as error:
        assert "owner_isolation" in str(error)
    else:
        raise AssertionError("missing owner isolation passed")
    bounded = next((source for source in sources if source["kind"] not in {"profile", *LEGACY_UNBOUNDED}), None)
    if bounded:
        changed = [dict(source) for source in sources]
        target = next(source for source in changed if source["kind"] == bounded["kind"])
        target["capacity"] = {**target["capacity"], "max_records": target["capacity"]["max_records"] + 1}
        try:
            validate(root, changed, records_code, sync_code)
        except ValueError as error:
            assert "runtime guard" in str(error)
        else:
            raise AssertionError("capacity mismatch passed")
        changed = [dict(source) for source in sources]
        target = next(source for source in changed if source["kind"] == bounded["kind"])
        target["capacity"] = {**target["capacity"], "max_retained_records": target["capacity"]["max_retained_records"] + 1}
        try:
            validate(root, changed, records_code, sync_code)
        except ValueError as error:
            assert "max_retained_records must match" in str(error)
        else:
            raise AssertionError("retained inventory capacity mismatch passed")
    try:
        registered_kinds(records_code, sync_code + '\ninputs.push({ kind: "undeclared" });')
    except ValueError as error:
        assert "typed and emitted" in str(error)
    else:
        raise AssertionError("undeclared runtime emission passed")
    outside = dict(code)
    outside["hushh-webapp/lib/pkm/unreviewed-source-writer.ts"] = (
        'PkmWriteCoordinator.saveMergedDomain({ domain: "one_living_sources", '
        'confirmation: { authorizationMode: "owner_source_projection" } });'
    )
    try:
        validate_writer_call_sites(outside)
    except ValueError as error:
        assert "runtime references changed" in str(error)
    else:
        raise AssertionError("new owner projection writer outside allowlist passed")
    inside = dict(code)
    path = "hushh-webapp/lib/pkm/living-source-sync.ts"
    inside[path] += '\nPkmWriteCoordinator.saveMergedDomain({ domain: LIVING_SOURCE_DOMAIN });'
    try:
        validate_writer_call_sites(inside)
    except ValueError as error:
        assert "mutation call sites changed" in str(error)
    else:
        raise AssertionError("new owner projection write under existing source kind passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    sources = parse_contract((ROOT / CONTRACT).read_text(encoding="utf-8"))
    records_code = (ROOT / RECORDS).read_text(encoding="utf-8")
    sync_code = (ROOT / SYNC).read_text(encoding="utf-8")
    code = runtime_sources(ROOT)
    if args.self_test:
        self_test(ROOT, sources, records_code, sync_code, code)
        print("Live Memory source gate negative controls passed")
    else:
        validate(ROOT, sources, records_code, sync_code)
        validate_writer_call_sites(code)
        validate_pr_event()
        print(f"Live Memory source gate passed ({len(sources)} registered source kinds)")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"Live Memory source gate failed: {error}") from error

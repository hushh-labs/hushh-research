#!/usr/bin/env python3
"""Ratchet declared Live Memory inventory source kinds against runtime registration."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from tempfile import TemporaryDirectory
from collections.abc import Iterable, Iterator
from pathlib import Path

from github_security_authority import GitHub, Refused
from live_memory_pr_context import impact_body

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = Path("docs/reference/architecture/live-memory-source-contract.md")
RECORDS = Path("hushh-webapp/lib/pkm/living-source-records.ts")
SYNC = Path("hushh-webapp/lib/pkm/living-source-sync.ts")
JOURNAL_SERVICE = Path("hushh-webapp/lib/services/source-journal-service.ts")
MIGRATIONS = Path("consent-protocol/db/migrations")
MIGRATION_NAME = re.compile(r"(\d+)_[a-z0-9_]+\.sql")
# The newest migration that declares live_memory_source_events.source_kind owns
# the SQL journal kinds. Only a static IN list is accepted, so a rewritten
# constraint fails here instead of silently skipping the parity check.
JOURNAL_TABLE_STATEMENT = re.compile(
    r"\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?)\s+"
    r"(?:public\.)?live_memory_source_events\b[^;]*",
    re.IGNORECASE,
)
JOURNAL_KIND_CHECK = re.compile(r"\bCHECK\s*\(\s*source_kind\b", re.IGNORECASE)
JOURNAL_KIND_IN_LIST = re.compile(r"\bCHECK\s*\(\s*source_kind\s+IN\s*\(([^()]*)\)\s*\)", re.IGNORECASE)
SQL_KIND_LIST = re.compile(r"\s*'[a-z][a-z0-9_]*'(?:\s*,\s*'[a-z][a-z0-9_]*')*\s*")
WEB_JOURNAL_KINDS = re.compile(r"\bexport\s+const\s+SOURCE_JOURNAL_KINDS\b[^=]*=\s*\[([^\]]*)\]")
WEB_KIND_LIST = re.compile(r'\s*"[a-z][a-z0-9_]*"(?:\s*,\s*"[a-z][a-z0-9_]*")*\s*,?\s*')
# Paid exact-scope answers read authoritative domains and Soul only. The owner
# inventory, its history, fact index, every Live Mirror module and the
# memory-refresh cache that serves peekLiveMirror stay out.
PAID_RETRIEVAL_FILES = (
    "hushh-webapp/lib/pkm/memory-scope-retrieval.ts",
    "hushh-webapp/lib/answers/answer-scope-availability.ts",
)
LIVE_MEMORY_MODEL_MODULE = re.compile(r"(?:(?:use-)?(?:living-source|live-mirror)-[a-z0-9-]+|memory-refresh)")
MODULE_SPECIFIER = re.compile(r"""(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"'\n]+)["']""")
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
# Native sync and compilation copy the already-reviewed web runtime here.
# Exclude exact generated roots, not all native code or untracked source files.
GENERATED_RUNTIME_ROOTS = {
    "hushh-webapp/out",
    "hushh-webapp/android/app/build",
    "hushh-webapp/android/app/src/main/assets/public",
    "hushh-webapp/ios/App/build",
    "hushh-webapp/ios/App/App/public",
}
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


def validate_pr_impact(body: str, admitted_kinds: set[str] | None = None) -> None:
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
    detail = evidence.group(1).strip()
    choice = choices[0]
    if choice.startswith(("Existing admitted source", "New source")):
        # A checked box and "N/A" used to pass. Require an actual source,
        # commit signal and focused test so CI can reject an empty feature
        # handoff before a reviewer has to infer coverage from prose.
        kind = re.search(r"(?:^|;)\s*kind:\s*([a-z][a-z0-9_]*)\s*(?:;|$)", detail)
        signal = re.search(r"(?:^|;)\s*signal:\s*([^;]+)", detail)
        test = re.search(
            r"(?:^|;)\s*test:\s*([^;\s]+(?:\.test\.(?:ts|tsx)|/test_[^/;\s]+\.py))\s*(?:;|$)",
            detail,
        )
        if not kind or not signal or not signal.group(1).strip() or not test:
            raise ValueError("Live Memory coverage needs kind, post-commit signal, and focused test")
        if admitted_kinds is not None and kind.group(1) not in admitted_kinds:
            raise ValueError(f"Live Memory source kind is not admitted: {kind.group(1)}")
        test_path = Path(test.group(1))
        if test_path.is_absolute() or ".." in test_path.parts or not (ROOT / test_path).is_file():
            raise ValueError("Live Memory focused test path is unavailable")
    elif len(detail) < 30 or detail.lower() in {"n/a", "none", "not applicable"}:
        raise ValueError("Live Memory exclusion or no-impact reason must be concrete")


def validate_pr_event(admitted_kinds: set[str]) -> None:
    if os.environ.get("GITHUB_EVENT_NAME") != "pull_request":
        return
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path:
        raise ValueError("pull_request event path is unavailable")
    event = json.loads(Path(event_path).read_text(encoding="utf-8"))
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    try:
        read = None if attempt == "1" else GitHub(repository, os.environ.get("GH_TOKEN", "")).read
        body = impact_body(event, attempt, repository, read)
    except Refused as error:
        raise ValueError("Current pull request authority is unavailable") from error
    validate_pr_impact(body, admitted_kinds)
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    print(f"Live Memory PR impact checked (attempt {attempt}, body sha256 {digest}).")


def registered_kinds(records_code: str, sync_code: str) -> tuple[set[str], set[str]]:
    match = re.search(r"export interface LivingSourceInput\s*\{[^}]*?\bkind:\s*([^;]+);", records_code, re.DOTALL)
    if not match:
        raise ValueError("cannot locate LivingSourceInput.kind registration union")
    union = match.group(1).strip()
    if not re.fullmatch(r'"[a-z][a-z0-9_]*"(?:\s*\|\s*"[a-z][a-z0-9_]*")*', union):
        raise ValueError("LivingSourceInput.kind must remain a static literal union")
    typed = set(re.findall(r'"([a-z][a-z0-9_]*)"', union))
    # Only constructors that produce LivingSourceInput rows count. Query
    # arguments such as `kind: "all"` and TS exclusion shapes such as
    # `{ kind: "earning" }` are unrelated to inventory registration.
    starts = [
        *re.finditer(r"\b(?:inputs|entries)\.push\(\s*\{", sync_code),
        *re.finditer(r"\bentries\.set\(\s*[^,()]+,\s*\{", sync_code),
    ]
    emitted: set[str] = set()
    for start in starts:
        literal = re.match(r'\s*kind:\s*"([a-z][a-z0-9_]*)"\s*,', sync_code[start.end():])
        if not literal:
            raise ValueError("LivingSourceInput constructor must begin with a static literal kind")
        emitted.add(literal.group(1))
    if not starts:
        raise ValueError("no LivingSourceInput constructors found")
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
            children[:] = [name for name in children if name not in EXCLUDED_RUNTIME_PARTS and not name.startswith(".")
                           and (Path(parent) / name).relative_to(root).as_posix() not in GENERATED_RUNTIME_ROOTS]
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


def migrations_newest_first(root: Path) -> Iterator[tuple[str, str]]:
    numbered = [
        (int(match.group(1)), path)
        for path in (root / MIGRATIONS).glob("*.sql")
        if (match := MIGRATION_NAME.fullmatch(path.name))
    ]
    for _, path in sorted(numbered, reverse=True):
        yield path.name, path.read_text(encoding="utf-8")


def sql_journal_kinds(migrations: Iterable[tuple[str, str]]) -> tuple[str, list[str]]:
    """Return the newest live_memory_source_events.source_kind CHECK; input is newest first."""
    for name, sql in migrations:
        sql = re.sub(r"--[^\n]*", " ", re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL))
        lists: list[list[str]] = []
        touched = False
        for statement in JOURNAL_TABLE_STATEMENT.finditer(sql):
            text = statement.group(0)
            touched = touched or "source_kind" in text.lower()
            bodies = JOURNAL_KIND_IN_LIST.findall(text)
            if len(bodies) != len(JOURNAL_KIND_CHECK.findall(text)) or not all(map(SQL_KIND_LIST.fullmatch, bodies)):
                raise ValueError(f"{name}: live_memory_source_events.source_kind CHECK must be a static IN list")
            lists.extend(re.findall(r"'([a-z][a-z0-9_]*)'", body) for body in bodies)
        if lists:
            return name, lists[-1]
        if touched:
            # A dropped or rewritten constraint must not fall back to an older list.
            raise ValueError(f"{name}: live_memory_source_events.source_kind CHECK must be a static IN list")
    raise ValueError("cannot locate the live_memory_source_events.source_kind CHECK")


def web_journal_kinds(code: str) -> list[str]:
    match = WEB_JOURNAL_KINDS.search(code)
    if not match or not WEB_KIND_LIST.fullmatch(match.group(1)):
        raise ValueError(f"SOURCE_JOURNAL_KINDS in {JOURNAL_SERVICE} must remain a static literal array")
    return re.findall(r'"([a-z][a-z0-9_]*)"', match.group(1))


def compare_journal_kinds(sql_kinds: list[str], web_kinds: list[str], declared: set[str], migration: str) -> None:
    if len(set(sql_kinds)) != len(sql_kinds) or len(set(web_kinds)) != len(web_kinds):
        raise ValueError("journal kinds must not repeat")
    if set(sql_kinds) != set(web_kinds):
        raise ValueError(
            f"journal kinds differ: {migration}={sorted(sql_kinds)}, {JOURNAL_SERVICE.name}={sorted(web_kinds)}"
        )
    if not set(sql_kinds) <= declared:
        raise ValueError(f"journal kinds are not declared sources: {sorted(set(sql_kinds) - declared)}")


def validate_journal_kinds(root: Path, sources: list[dict], code: dict[str, str]) -> None:
    if JOURNAL_SERVICE.as_posix() not in code:
        raise ValueError(f"journal client is missing: {JOURNAL_SERVICE}")
    migration, sql_kinds = sql_journal_kinds(migrations_newest_first(root))
    web_kinds = web_journal_kinds(code[JOURNAL_SERVICE.as_posix()])
    compare_journal_kinds(sql_kinds, web_kinds, {source["kind"] for source in sources}, migration)


def validate_paid_retrieval_imports(code: dict[str, str]) -> None:
    for path in PAID_RETRIEVAL_FILES:
        if path not in code:
            raise ValueError(f"paid retrieval file is missing: {path}")
        for specifier in MODULE_SPECIFIER.findall(code[path]):
            parts = specifier.split("/")
            parts[-1] = re.sub(r"\.[cm]?[jt]sx?$", "", parts[-1])
            if any(LIVE_MEMORY_MODEL_MODULE.fullmatch(part) for part in parts):
                raise ValueError(f"paid retrieval imports the Live Memory model: {path} -> {specifier}")


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
        "  - Live Memory evidence (source kind and test, or no-impact reason): kind: profile; signal: committed identity change; test: hushh-webapp/__tests__/lib/pkm/living-source-sync.test.ts",
        PR_IMPACT_END))
    validate_pr_impact(valid_pr, {source["kind"] for source in sources})
    for invalid in (valid_pr.replace("[x]", "[ ]"),
                    valid_pr.replace("kind: profile; signal: committed identity change; test: hushh-webapp/__tests__/lib/pkm/living-source-sync.test.ts", "N/A"),
                    valid_pr.replace("kind: profile", "kind: undeclared"),
                    valid_pr.replace("living-source-sync.test.ts", "missing-source.test.ts"),
                    valid_pr.replace(PR_IMPACT_START, "")):
        try:
            validate_pr_impact(invalid, {source["kind"] for source in sources})
        except ValueError:
            pass
        else:
            raise AssertionError("incomplete PR Live Memory impact passed")
    no_impact = "\n".join((PR_IMPACT_START,
        "  - [x] No durable owner data is created, changed, or deleted; reason listed below",
        "  - Live Memory evidence (source kind and test, or no-impact reason): This PR only changes static copy and has no owner data writes.",
        PR_IMPACT_END))
    validate_pr_impact(no_impact, {source["kind"] for source in sources})
    try:
        validate_pr_impact(no_impact.replace("This PR only changes static copy and has no owner data writes.", "N/A"))
    except ValueError:
        pass
    else:
        raise AssertionError("empty no-impact reason passed")
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
        registered_kinds(records_code, sync_code + '\ninputs.push({ kind: "undeclared", id: "x" });')
    except ValueError as error:
        assert "typed and emitted" in str(error)
    else:
        raise AssertionError("undeclared runtime emission passed")
    registered_kinds(records_code, sync_code + '\nconst query = { kind: "all" }; type Earning = { kind: "earning" };')
    try:
        registered_kinds(records_code, sync_code + '\ninputs.push({ kind: dynamicKind, id: "x" });')
    except ValueError as error:
        assert "static literal kind" in str(error)
    else:
        raise AssertionError("dynamic inventory source kind passed")
    outside = dict(code)
    outside["hushh-webapp/lib/pkm/unreviewed-source-writer.ts"] = (
        'PkmWriteCoordinator.saveMergedDomain({ domain: "one_living_sources", '
        'confirmation: { authorizationMode: "owner_source_projection" } });'
    )
    with TemporaryDirectory(prefix="hussh-source-gate-") as temporary:
        fixture_root = Path(temporary)
        authored = "hushh-webapp/lib/pkm/unreviewed-source-writer.ts"
        for relative in [authored, *(f"{directory}/copied-runtime.js" for directory in GENERATED_RUNTIME_ROOTS)]:
            fixture = fixture_root / relative
            fixture.parent.mkdir(parents=True, exist_ok=True)
            fixture.write_text(outside[authored], encoding="utf-8")
        scanned = runtime_sources(fixture_root)
        assert set(scanned) == {authored}, "native build copies must not mask or duplicate an authored writer"
        outside = {**code, **scanned}
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
    self_test_journal_kinds(root, sources, code)
    self_test_paid_retrieval_imports(code)


def self_test_journal_kinds(root: Path, sources: list[dict], code: dict[str, str]) -> None:
    validate_journal_kinds(root, sources, code)
    migration, sql_kinds = sql_journal_kinds(migrations_newest_first(root))
    web_kinds = web_journal_kinds(code[JOURNAL_SERVICE.as_posix()])
    declared = {source["kind"] for source in sources}
    for drifted_sql, drifted_web in ((sql_kinds, [*web_kinds, "location"]),
                                     ([kind for kind in sql_kinds if kind != "profile"], web_kinds)):
        try:
            compare_journal_kinds(drifted_sql, drifted_web, declared, migration)
        except ValueError as error:
            assert "journal kinds differ" in str(error)
        else:
            raise AssertionError("journal kind drift passed")
    try:
        compare_journal_kinds([*sql_kinds, "location"], [*web_kinds, "location"], declared, migration)
    except ValueError as error:
        assert "not declared sources" in str(error)
    else:
        raise AssertionError("undeclared journal kind passed")
    # A newer migration owns the list, so narrowing it there must be caught.
    current = (migration, (root / MIGRATIONS / migration).read_text(encoding="utf-8"))
    newer = ("999_journal_kinds.sql", "-- newer\nALTER TABLE public.live_memory_source_events "
             "ADD CONSTRAINT live_memory_source_kind CHECK (source_kind IN ('consent'));")
    assert sql_journal_kinds([current]) == (migration, sql_kinds)
    narrowed = sql_journal_kinds([newer, current])
    assert narrowed == ("999_journal_kinds.sql", ["consent"])
    try:
        compare_journal_kinds(narrowed[1], web_kinds, declared, narrowed[0])
    except ValueError as error:
        assert "journal kinds differ" in str(error)
    else:
        raise AssertionError("narrowed newer journal CHECK passed")
    for unreadable in ("ADD CONSTRAINT k CHECK (source_kind = ANY (ARRAY['profile'::text]))",
                       "ADD CONSTRAINT k CHECK (source_kind IN (SELECT kind FROM k))",
                       "ADD CONSTRAINT k CHECK (source_kind IN ('consent')), "
                       "ADD CONSTRAINT j CHECK (source_kind = ANY (ARRAY['profile'::text]))",
                       "DROP CONSTRAINT live_memory_source_events_source_kind_check"):
        try:
            sql_journal_kinds([("999_journal_kinds.sql", f"ALTER TABLE live_memory_source_events {unreadable};"),
                               current])
        except ValueError as error:
            assert "static IN list" in str(error)
        else:
            raise AssertionError("unparsed or dropped journal CHECK passed")
    service = code[JOURNAL_SERVICE.as_posix()]
    start = WEB_JOURNAL_KINDS.search(service).start(1)
    dynamic = f"{service[:start]}...BASE_JOURNAL_KINDS, {service[start:]}"
    try:
        web_journal_kinds(dynamic)
    except ValueError as error:
        assert "static literal array" in str(error)
    else:
        raise AssertionError("dynamic web journal kinds passed")


def self_test_paid_retrieval_imports(code: dict[str, str]) -> None:
    validate_paid_retrieval_imports(code)
    retrieval, availability = PAID_RETRIEVAL_FILES
    for path, injected in (
        (retrieval, 'import { buildOwnerLivingFactIndex } from "@/lib/pkm/living-source-fact-index";'),
        (retrieval, 'import type { LivingSourceInventory } from "@/lib/pkm/living-source-records";'),
        (retrieval, 'import {\n  buildLiveMirrorProjection,\n} from "./live-mirror-projection.ts";'),
        (availability, 'export type { LiveMirrorView } from "../pkm/live-mirror-contract";'),
        (availability, 'const facts = await import("@/lib/pkm/live-mirror-agent-facts");'),
        (availability, 'import { peekLiveMirror } from "@/lib/pkm/memory-refresh";'),
        (retrieval, 'import type { MemoryView } from "./memory-refresh.ts";'),
    ):
        changed = dict(code)
        changed[path] = f"{injected}\n{changed[path]}"
        try:
            validate_paid_retrieval_imports(changed)
        except ValueError as error:
            assert "paid retrieval imports the Live Memory model" in str(error)
        else:
            raise AssertionError("Live Memory model import into paid retrieval passed")
    # The authoritative slice store and Soul reader remain the only memory path.
    allowed = dict(code)
    store = 'import { readMemoryDocumentProjection } from "@/lib/pkm/memory-document-store";'
    allowed[retrieval] = f"{store}\n{allowed[retrieval]}"
    validate_paid_retrieval_imports(allowed)
    renamed = {path: text for path, text in code.items() if path != availability}
    try:
        validate_paid_retrieval_imports(renamed)
    except ValueError as error:
        assert "paid retrieval file is missing" in str(error)
    else:
        raise AssertionError("missing paid retrieval file passed")


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
        validate_journal_kinds(ROOT, sources, code)
        validate_paid_retrieval_imports(code)
        validate_pr_event({source["kind"] for source in sources})
        print(f"Live Memory source gate passed ({len(sources)} registered source kinds)")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"Live Memory source gate failed: {error}") from error

#!/usr/bin/env python3
"""Record verdicts on the memory-learning review queue, then score or void the run.

``pod_lifecycle_drill.py --memory`` writes a blinded, sealed review queue and
stops. Nothing on this side could read one back, so the judged quality number
the completion ledger asks for (``quality_judged_independently``) had no honest
way to be produced: a grading session could only append to ``verdicts.jsonl``
with a shell redirect, unvalidated, and no code anywhere turned those lines into
a score or refused to. This file is that missing half.

It is deliberately two narrow operations, not one:

``record``
    The sanctioned writer. It appends exactly one validated verdict and cannot
    truncate the file, rewrite a verdict, or touch the queue and manifest it is
    grading. It refuses a duplicate id, an id that is not in the queue, a
    ``wrong`` with no citation in that row's output or utterance, and any rule
    the run did not declare. Rejecting at write time matters: the judge still
    has the row in front of it and can fix the verdict, instead of discovering
    at scoring time that its work was thrown away. Every accepted verdict is
    also counted in an append-only write ledger, which is the only thing that
    can see a verdict DELETED and given again: the chain that remains after a
    truncation is a prefix of a valid chain, and therefore valid.

``ingest``
    Scores the run, or refuses to. Every void condition in the judging contract
    is checked, and a void run publishes NO accuracy at all -- not a number with
    a caveat, because a number with a caveat gets quoted without the caveat. The
    report literally does not contain a score field when the run is void, so
    there is nothing to quote.

THE THREAT MODEL, AND THE ONE PART OF IT THAT CHANGED
-----------------------------------------------------
The grading lane is ``sandbox_mode = "read-only"`` and now genuinely runs that
way: it emits its verdicts and the orchestrator puts them through ``replay``,
which is ``record`` in a loop. Before, the lane was audited as read-only and
instructed to write, which is a contradiction that resolves silently in either
direction. A grader that cannot write cannot edit the queue, the manifest, the
verdicts, the ledger, this module, or a seal it locates, so those move from
detected to prevented. What ``replay`` costs is set out in its own docstring
and is not recovered here.

Everything below is what remains for a party that does hold a shell -- an
operator, or a grading session run outside the sandbox. For those, what is
available is detection: the salted row
hashes, the control commitment, the rule commitment, the drill's hash, this
module's own hash and the re-issue counter all live in the seal OUTSIDE the run
directory, and any of them disagreeing voids the run. That converts "the judge can cheat invisibly"
into "the judge can cheat and the result is discarded". A judge that finds the
seal can still forge a consistent one; the fix for that is a sandbox, which is
infrastructure, not code.

Four limits of that detection, stated rather than implied:

*   **Blinding is not one of the things the seal protects.** Two shortcuts are
    closed and one is not. Moving the shuffle seed into the seal closed the
    path that needed nothing but the manifest and a Python interpreter, and
    minting that seed per issue closed the worse one, a constant default that
    gave every production run the same planted positions. What remains is
    content: the six planted rows are literals in ``memory_judge_controls`` in
    the harness source, over a corpus fixed in that same file, so a grader that
    reads it -- or that has simply graded this corpus before -- recognises them
    wherever the shuffle puts them. Nothing at this layer can close that;
    content-level blinding needs a corpus minted per run. The report says which
    runs had unpredictable positions (``blinding``); the grader being new to
    the corpus and not reading the harness stays a discipline.
*   **A re-issue that discards verdicts is detectable only if the ledgers
    survive.** ``count_recorded_verdicts`` takes the larger of
    ``verdicts.jsonl`` and ``verdict-writes.jsonl``, so deleting one before
    re-issuing does not zero the count -- but both live inside the run
    directory, and a party that deletes both re-issues with
    ``discarded_verdicts_total`` at zero, which is the ``reissued_after_verdicts``
    void gone. What that does NOT erase is the re-issue itself: the counter is
    carried over from the run's live seal, so the new one still says
    ``ordinal: 2`` and every report prints it. The move buys the void, not the
    trace, and erasing the trace as well means deleting that live seal before
    re-issuing, a second move in a directory ``--judge-seal-dir`` can put out
    of the grading session's reach. The only append-only store outside the run
    directory is that seal directory, and ``record`` is the grader's own
    command: handing it that path to stamp a tally would hand over the answer
    key, which is a worse trade than the bypass. It needs a sandbox, like the
    rest of this list.
*   **The source hashes are checked by the source they cover.** The seal commits
    to this file, but the comparison runs here, so a party that edits this file
    can delete the comparison in the same edit. The commitment catches an edit
    made by someone who did not also think to disarm the checker, and it lets
    an operator re-verify the hashes from outside with the seal in hand. It is
    not a defence against an attacker who read this paragraph. Self-hashing
    cannot be made non-circular at this layer; the read-only grading sandbox is
    what removes the grader from this list, and it does not remove an operator.
*   **The seal is not authentication, and its name is not concealment.** The
    filename is a salted hash of the run directory, so nothing in the run
    directory names it and nothing the grader is handed derives it. It does not
    have to be derived: with the default seal directory
    (``<run_dir>/../.judge-seals``) it is one ``..`` from the queue path the
    receipt publishes: a party lists the directory and identifies the run's
    seal by the ``run_dir_sha256`` each one carries, exactly as ``find_seals``
    does. Reading it is enough to hold the answer key even without a write, so
    the read-only sandbox does not close this one. Only ``--judge-seal-dir``
    pointed somewhere the grading session was never told about makes the
    location itself a barrier, and the drill's receipt now says which of the
    two a given run had (``seal_location_derivable_from_receipt``) instead of
    asserting a constant ``seal_outside_run_dir: True``. What the run directory must
    never carry is anything EQUIVALENT to the seal's contents -- its filename,
    its salt, or the shuffle seed (see ``MANIFEST_FORBIDDEN_KEYS``) -- because
    those need no listing at all.

Scoring never calls a clock. Every timestamp in the report is read back from the
manifest that the drill stamped at issue time, so re-ingesting a run produces a
byte-identical report.

Contract: ``.codex/skills/puppy-one-harness/references/judging-contract.md``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

QUEUE_FILENAME = "review-queue.jsonl"
MANIFEST_FILENAME = "run-manifest.json"
VERDICTS_FILENAME = "verdicts.jsonl"
# One line per call to ``record``, written beside the verdicts. Truncating
# verdicts.jsonl and re-recording through the sanctioned writer leaves a chain
# that validates -- the prefix is genuinely intact -- so the only way to see a
# deleted verdict is to count the writes somewhere else.
WRITE_LEDGER_FILENAME = "verdict-writes.jsonl"
SEAL_DIRNAME = ".judge-seals"
SEAL_SUFFIX = ".seal.json"
HARNESS_FILENAME = "pod_lifecycle_drill.py"

# Manifest fields that would locate the planted rows, mapped to why. A run
# whose manifest carries one voids, instead of the prose that tells the grader
# this file is readable quietly becoming wrong again. It catches only the keys
# listed here, which is why ``tests/test_memory_judge.py`` also pins the
# manifest's whole key set: a NEW leaking field needs a reviewed edit there,
# and this dict is where it would then be named.
#
# ``seed`` is the whole of it today, and it is not a reproducibility field:
# the controls are appended to the rows in a fixed order, so replaying
# ``random.Random(seed).shuffle`` over the manifest's own row and control
# counts reproduces every planted position and its negative/positive kind,
# from the manifest alone, with no seal and no harness source. It lives in
# the seal now, beside the answer key it is equivalent to.
MANIFEST_FORBIDDEN_KEYS: dict[str, str] = {
    "seed": (
        "replaying the shuffle over the manifest's own row and control counts "
        "recomputes every planted position and its kind."
    ),
}

# The manifest fields that ATTRIBUTE the run, and the salted commitment the
# seal carries over them. Repeated from ``pod_lifecycle_drill`` rather than
# imported: the scoring half loads no module out of the harness it is sealing
# against, and a disagreement between the two copies voids every run loudly
# instead of passing one quietly.
IDENTITY_FIELDS: tuple[str, ...] = ("suite", "run_id", "created_at", "answerer_model")

# How the shuffle seed was obtained, as the seal records it. A run issued with
# a supplied seed has the planted positions of every other run issued with that
# seed, so it is reported as a replay rather than as a blinded run.
SEED_MINTED = "minted-at-issue"
SEED_SUPPLIED = "operator-supplied"

# A citation shorter than this quotes nothing: "a" is a substring of half the
# English language, and accepting it makes "a `wrong` must quote the offending
# value" enforce nothing at all. The floor is deliberately low, because a real
# offending value can be two characters ("12"), and the boundary check below is
# what does the actual work.
MIN_CITATION_CHARS = 2

VERDICT_CORRECT = "correct"
VERDICT_WRONG = "wrong"
VERDICT_UNSURE = "unsure"
VERDICTS: tuple[str, ...] = (VERDICT_CORRECT, VERDICT_WRONG, VERDICT_UNSURE)

# The verdict hash chain's fixed root. Chaining makes a revised earlier verdict
# break every verdict after it, and makes a line appended past the writer (with
# no chain at all) visible. It is not authentication: a judge that rewrites the
# whole file can recompute the chain, and a judge that deletes the LAST line
# leaves a prefix that still validates, which is why the write ledger above
# exists. The chain alone catches the edit, not the rewrite.
CHAIN_GENESIS = "verdict-chain-genesis"


class JudgeError(RuntimeError):
    """The run cannot be read or written at all. Distinct from a void run."""


@dataclass(frozen=True)
class Violation:
    """One detected reason the run cannot publish a number."""

    kind: str
    detail: str

    def to_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "detail": self.detail}


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _as_int(value: Any, default: int) -> int:
    """A counter read out of a JSON file nobody here wrote. Never raises."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def identity_commitment(manifest: dict[str, Any], salt: str) -> str:
    """What the seal committed to when it recorded who this run is about."""
    fields = {field: str(manifest.get(field, "")) for field in IDENTITY_FIELDS}
    return _sha(salt + json.dumps(fields, sort_keys=True))


def identity_is_sealed(seal: dict[str, Any] | None, manifest: dict[str, Any]) -> bool:
    """The manifest's attribution is the one the run was issued under.

    False when there is no seal, when the seal predates the commitment, and
    when any of the four fields was edited after issue. It is reported on every
    report, scored or void, because the number this harness produces is a
    quality claim ABOUT a named model: published without this, the attribution
    was the one thing in the report that nothing checked.
    """
    if not isinstance(seal, dict):
        return False
    sealed = str(seal.get("identity_sha256") or "")
    salt = str(seal.get("salt") or "")
    return bool(sealed) and sealed == identity_commitment(manifest, salt)


def _canonical_row(row: dict[str, Any]) -> str:
    """The exact line the drill hashed when it issued this row.

    The drill writes ``json.dumps(row, sort_keys=True)`` over a dict of exactly
    ``id``, ``utterance`` and ``output``, so rebuilding those three keys in that
    shape reproduces the issued bytes. Anything else in the row was added after
    issue, and the hash comparison is what says so.
    """
    return json.dumps(
        {"id": row.get("id"), "utterance": row.get("utterance"), "output": row.get("output")},
        sort_keys=True,
    )


def _read_json(path: Path) -> dict[str, Any]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise JudgeError(f"cannot read {path}: {exc}")
    except ValueError as exc:
        raise JudgeError(f"{path} is not valid JSON: {exc}")
    if not isinstance(loaded, dict):
        raise JudgeError(f"{path} must hold a JSON object")
    return loaded


def load_queue(run_dir: Path | str) -> dict[str, dict[str, Any]]:
    """The rows as issued, keyed by id."""
    path = Path(run_dir) / QUEUE_FILENAME
    if not path.exists():
        raise JudgeError(f"no review queue at {path}")
    rows: dict[str, dict[str, Any]] = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError as exc:
            raise JudgeError(f"{path} line {number} is not valid JSON: {exc}")
        rows[str(row.get("id"))] = row
    if not rows:
        raise JudgeError(f"{path} holds no rows")
    return rows


def load_manifest(run_dir: Path | str) -> dict[str, Any]:
    return _read_json(Path(run_dir) / MANIFEST_FILENAME)


def declared_rules(manifest: dict[str, Any]) -> tuple[str, ...]:
    """The rule vocabulary this run may cite.

    Taken from the manifest rather than hardcoded here, because the vocabulary
    is a property of the suite being graded, not of the grader. The seal commits
    to it, so widening the manifest is detected at ingest instead of quietly
    becoming the new standard.
    """
    rules = manifest.get("rules")
    if not isinstance(rules, list) or not rules:
        raise JudgeError(f"{MANIFEST_FILENAME} declares no rule vocabulary")
    return tuple(str(rule) for rule in rules)


def read_verdicts(run_dir: Path | str) -> list[dict[str, Any]]:
    """Every recorded verdict, in file order. Order is what the chain checks."""
    path = Path(run_dir) / VERDICTS_FILENAME
    if not path.exists():
        return []
    entries: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            # A line nothing can parse is not a verdict. It leaves its row
            # ungraded, which voids the run on its own and points at the file.
            continue
        if isinstance(entry, dict):
            entries.append(entry)
    return entries


def read_write_ledger(run_dir: Path | str) -> list[str]:
    """Every chain head the sanctioned writer ever emitted, in write order.

    This is what makes a DELETED verdict visible. The chain alone cannot see
    one: drop the last line of ``verdicts.jsonl`` and the remaining prefix is a
    genuinely valid chain, so re-recording through the writer produces a file
    that validates end to end while the judge has quietly revised its mind. The
    ledger is append-only and never rewritten, so the count and the heads
    disagree the moment a line goes missing. A judge that truncates both files
    in step defeats it, exactly as it defeats every other control here; the
    point is detection of the edit, not prevention.
    """
    path = Path(run_dir) / WRITE_LEDGER_FILENAME
    if not path.exists():
        return []
    heads: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and entry.get("head"):
            heads.append(str(entry["head"]))
    return heads


def chain_head(entries: list[dict[str, Any]]) -> str:
    """Fold the verdicts, in order, into one hash."""
    running = _sha(CHAIN_GENESIS)
    for entry in entries:
        payload = json.dumps(
            {
                "id": entry.get("id"),
                "verdict": entry.get("verdict"),
                "rule": entry.get("rule", ""),
                "citation": entry.get("citation", ""),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        running = _sha(running + "\x00" + payload)
    return running


def _quotes(needle: str, haystack: str) -> bool:
    """``needle`` appears in ``haystack`` as a span, not as a fragment of a word.

    A plain substring test accepts ``a`` against "Barnaby" and calls it a
    citation. Requiring the match to begin and end on a token boundary, where
    the citation's own edge is alphanumeric, rejects that while still accepting
    a short real value: ``12`` in "slip 12" matches, ``12`` in "4126" does not.
    """
    start = 0
    while True:
        at = haystack.find(needle, start)
        if at < 0:
            return False
        before = haystack[at - 1] if at else ""
        end = at + len(needle)
        after = haystack[end] if end < len(haystack) else ""
        opens = not (needle[0].isalnum() and before.isalnum())
        closes = not (needle[-1].isalnum() and after.isalnum())
        if opens and closes:
            return True
        start = at + 1


def citation_supports(citation: str, row: dict[str, Any]) -> bool:
    """A citation must quote something that was actually in front of the judge.

    Checked against the output OR the utterance. Output-only would silently
    penalise correct judgement: an omission failure -- the private agent dropped a fact
    the owner stated -- has nothing to quote in the output by definition, since
    the complaint is that it is absent. Forcing those to ``unsure``, which counts
    against accuracy, would train a judge away from reporting the one failure
    class that loses the owner's records.
    """
    needle = str(citation or "").strip().strip('"').casefold()
    if len(needle) < MIN_CITATION_CHARS:
        return False
    # ensure_ascii=False so a citation carrying a non-ASCII character is not
    # compared against its \uXXXX escape and discarded as unfound.
    haystack = json.dumps(row.get("output"), sort_keys=True, ensure_ascii=False).casefold()
    if _quotes(needle, haystack):
        return True
    return _quotes(needle, str(row.get("utterance") or "").casefold())


# --------------------------------------------------------------------------- #
# record: the sanctioned, append-only, validating writer.
# --------------------------------------------------------------------------- #


def record(
    *,
    run_dir: Path | str,
    row_id: str,
    verdict: str,
    rule: str = "",
    citation: str = "",
    note: str = "",
) -> dict[str, Any]:
    """Validate one verdict and append it. Raises rather than writing junk."""
    directory = Path(run_dir)
    queue = load_queue(directory)
    rules = declared_rules(load_manifest(directory))

    if row_id not in queue:
        # A hallucinated id would otherwise leave a real row ungraded and void
        # the run for a reason that points at the wrong thing.
        raise JudgeError(
            f"row {row_id!r} is not in the queue; the queue holds {', '.join(sorted(queue)[:6])}..."
        )
    if verdict not in VERDICTS:
        raise JudgeError(f"verdict must be one of {', '.join(VERDICTS)}, got {verdict!r}")

    existing = read_verdicts(directory)
    if any(str(entry.get("id")) == row_id for entry in existing):
        raise JudgeError(
            f"row {row_id!r} already has a verdict; a second one is either a "
            "mistake or an overwrite, and both should be seen rather than "
            "resolved silently"
        )
    if rule and rule not in rules:
        # Improvising a rule produces a failure that looks fully compliant --
        # cited, well formed -- while grading against a standard nobody agreed
        # to. Refused here, and void at ingest if it arrives another way.
        raise JudgeError(
            f"rule {rule!r} is not one of the rules this run declares: {', '.join(rules)}"
        )
    if verdict == VERDICT_WRONG:
        if not rule:
            raise JudgeError("a `wrong` verdict must name the rule it broke")
        if not citation_supports(citation, queue[row_id]):
            raise JudgeError(
                "a `wrong` verdict must quote the offending value verbatim from "
                "this row's output, or the utterance span that went unrecorded "
                "when the failure is an omission. If you cannot quote it, the "
                "verdict is `unsure`."
            )

    entry: dict[str, Any] = {
        "id": row_id,
        "verdict": verdict,
        "rule": rule,
        "citation": citation,
        "note": note,
    }
    entry["chain"] = chain_head([*existing, entry])
    with (directory / VERDICTS_FILENAME).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")
    # The write ledger, second: a crash between the two writes leaves the run
    # void rather than scored, which is the safe direction to fail. The sequence
    # counts WRITES, taken from the ledger's own length and never from the
    # verdicts file, so deleting a verdict cannot walk the counter backwards.
    with (directory / WRITE_LEDGER_FILENAME).open("a", encoding="utf-8") as handle:
        handle.write(
            json.dumps(
                {"sequence": len(read_write_ledger(directory)) + 1, "head": entry["chain"]},
                sort_keys=True,
            )
            + "\n"
        )
    return entry


SUBMISSION_FILENAME = "grader-submission.jsonl"
_SUBMISSION_FIELDS = {"id", "verdict", "rule", "citation", "note"}


def replay(
    *,
    run_dir: Path | str,
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Put a read-only grader's verdict lines through ``record``, one at a time.

    WHY THIS EXISTS, AND WHY IT IS NOT A BYPASS
    -------------------------------------------
    Every lane in ``agents/`` is ``sandbox_mode = "read-only"``, and
    ``agent_fleet_audit.py`` hard-fails one that is not. The judge lane was
    declared read-only and then told, in its own developer instructions, to run
    a command that appends to two files. Both cannot be true. Whichever way a
    given host resolved it, the resolution was silent: either the lane held a
    shell it was audited as not holding, or the instruction was unfollowable and
    the run produced nothing.

    Read-only is the half worth keeping, because it is the sandbox the threat
    model at the top of this file says is the actual fix. A grader that cannot
    write cannot edit the queue, the manifest, the verdicts, the write ledger,
    this module, or a seal it managed to locate. That closes, by construction,
    most of what the seal could previously only detect.

    So the grader emits its verdicts and the ORCHESTRATOR replays them here.
    What that does NOT do is move the validation: every row still goes through
    ``record``, so the citation check, the rule check, the unknown-id check and
    the duplicate check all still apply, and the write ledger still gets exactly
    one line per accepted verdict. ``verdict_appended_past_writer`` fires on a
    verdict that never passed the writer, which is a property of the line, not
    of who typed the command. A replayed run has a ledger line behind every
    verdict and does not void.

    WHAT IT COSTS, STATED RATHER THAN BURIED
    ----------------------------------------
    Two things, and neither is recovered by anything in this file.

    *   **The grader loses the immediate refusal.** ``record`` refusing an
        uncited ``wrong`` while the grader still has the row in front of it was
        a real property. Replaying moves that refusal to the orchestrator, so
        the orchestrator has to hand it back. This stops at the first refusal
        and names the row precisely so that handing it back is possible; a
        replay that swallowed refusals and carried on would be strictly worse
        than what it replaced.
    *   **The orchestrator could alter a verdict in transit.** It could not
        before. The mitigation is evidence, not prevention: every submission is
        appended verbatim to ``grader-submission.jsonl`` before any of it is
        written, so the recorded verdicts can always be diffed against what the
        grader actually said, and a second submission is visible beside the
        first rather than replacing it.

        An earlier version REFUSED a submission that disagreed with the one on
        disk, which sounded like the stronger control and was simply wrong: the
        fix-and-resubmit loop in the paragraph above produces a differing
        submission every time, so the guard refused the one path the design
        depends on. Changing a verdict that is already recorded is refused
        where it was always refused, by ``record``'s duplicate check, which
        cannot be talked past by resubmitting.

    Rows already recorded IDENTICALLY are skipped, not re-written, so a replay
    interrupted halfway can simply be run again. A row whose id is already
    recorded with any different verdict, rule, citation or note is refused by
    ``record`` as the revision it is.
    """
    directory = Path(run_dir)
    if not rows:
        raise JudgeError("no verdict rows to replay")

    normalised: list[dict[str, str]] = []
    for position, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise JudgeError(f"line {position}: expected one JSON object per line")
        unknown = sorted(set(row) - _SUBMISSION_FIELDS)
        if unknown:
            # `chain` is the one that matters: it is computed here, over the
            # verdicts already on disk, and a submitted one is either noise or
            # an attempt to choose it.
            raise JudgeError(
                f"line {position}: unexpected field(s) {', '.join(unknown)}; a submission "
                f"carries only {', '.join(sorted(_SUBMISSION_FIELDS))}"
            )
        if not str(row.get("id") or ""):
            raise JudgeError(f"line {position}: missing id")
        normalised.append({key: str(row.get(key) or "") for key in sorted(_SUBMISSION_FIELDS)})

    # Append-only, one line per submission, written BEFORE anything is recorded
    # so a replay that refuses partway still leaves what the grader said.
    submission_path = directory / SUBMISSION_FILENAME
    with submission_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"rows": normalised}, sort_keys=True) + "\n")

    already = {str(entry.get("id")): entry for entry in read_verdicts(directory)}
    recorded: list[str] = []
    skipped: list[str] = []
    for position, row in enumerate(normalised, start=1):
        row_id = row["id"]
        prior = already.get(row_id)
        if prior is not None:
            same = all(
                str(prior.get(key, "")) == row[key] for key in ("verdict", "rule", "citation")
            )
            if same:
                skipped.append(row_id)
                continue
        try:
            record(
                run_dir=directory,
                row_id=row_id,
                verdict=row["verdict"],
                rule=row["rule"],
                citation=row["citation"],
                note=row["note"],
            )
        except JudgeError as exc:
            raise JudgeError(
                f"line {position} (row {row_id}): {exc}. {len(recorded)} verdict(s) were "
                "recorded before this one; fix this row with the grader and replay the "
                "same submission again, which resumes rather than duplicating."
            ) from exc
        recorded.append(row_id)
    return {
        "recorded": recorded,
        "already_recorded": skipped,
        "submission": str(submission_path),
        "submissions_on_file": sum(
            1 for line in submission_path.read_text(encoding="utf-8").splitlines() if line.strip()
        ),
    }


def read_submission(source: Path | str | None) -> list[dict[str, Any]]:
    """Parse grader-emitted JSONL from a file, or from stdin when None."""
    text = sys.stdin.read() if source is None else Path(source).read_text(encoding="utf-8")
    rows: list[dict[str, Any]] = []
    for position, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            rows.append(json.loads(stripped))
        except json.JSONDecodeError as exc:
            raise JudgeError(f"line {position} is not JSON: {exc}") from exc
    return rows


def discarded_verdicts(
    queue: dict[str, dict[str, Any]], by_row: dict[str, dict[str, Any]]
) -> list[str]:
    """The rows whose verdict quotes nothing and is therefore thrown away.

    One definition, shared by ``progress`` and ``ingest``, so the view a grader
    checks and the view that scores the run can never disagree about whether a
    row has been graded.
    """
    return sorted(
        row_id
        for row_id, entry in by_row.items()
        if row_id in queue
        and str(entry.get("verdict")) == VERDICT_WRONG
        and not citation_supports(str(entry.get("citation") or ""), queue[row_id])
    )


def progress(run_dir: Path | str) -> dict[str, Any]:
    """How much of the queue is graded. Every row must be, or the run voids."""
    directory = Path(run_dir)
    queue = load_queue(directory)
    by_row = {str(entry.get("id")): entry for entry in read_verdicts(directory)}
    graded = (set(by_row) & set(queue)) - set(discarded_verdicts(queue, by_row))
    remaining = sorted(set(queue) - graded)
    return {
        "total": len(queue),
        "graded": len(graded),
        "remaining": remaining,
        "complete": not remaining,
    }


# --------------------------------------------------------------------------- #
# ingest: score the run, or refuse to.
# --------------------------------------------------------------------------- #


def seal_search_root(run_dir: Path, seal_dir: Path | str | None = None) -> Path:
    return Path(seal_dir) if seal_dir is not None else run_dir.parent / SEAL_DIRNAME


def find_seals(run_dir: Path, *, seal_dir: Path | str | None = None) -> list[Path]:
    """Every seal under the search root that was issued for THIS run directory.

    Deliberately a search and not a lookup. The seal's filename is a salted hash
    the grader cannot derive, and nothing the grader is given -- not the queue,
    not the manifest, not the receipt -- may name it, because the seal holds the
    plaintext control map: which rows are planted, and which rule each breaks.
    Publishing a field that IS the filename would hand a grader holding only the
    manifest the answer key it is being measured against.

    Ingest therefore finds the seal the only way left: open the candidates and
    ask each one which run it was issued for. That costs a directory listing,
    which ingest is entitled to and the grader is not.

    Exactly one seal per run directory is live at a time. Re-issuing the drill
    into the same directory supersedes the previous seal, renaming it out of
    this glob, so more than one candidate here is a seal that was copied or
    planted rather than the ordinary cost of running the drill twice.
    """
    root = seal_search_root(run_dir, seal_dir)
    if not root.is_dir():
        return []
    issued_for = _sha(run_dir.resolve().as_posix())
    found: list[Path] = []
    for candidate in sorted(root.glob(f"*{SEAL_SUFFIX}")):
        try:
            loaded = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(loaded, dict) and str(loaded.get("run_dir_sha256") or "") == issued_for:
            found.append(candidate)
    return found


def _select_seal(seal_path: Path | str | None, matches: list[Path]) -> Path | None:
    """The one seal to check against, or ``None`` when there is not exactly one.

    Two callers, one definition, because the alternative was ``ingest``
    re-deriving the same expression inline and the public helper drifting away
    from what scoring actually does.

    ``matches[0]`` would silently pick one of two answer keys, which is the same
    defect as scoring a run whose seal nobody can identify, one level down. The
    caller that can say so reports the ambiguity; nothing here resolves it by
    sort order.

    The returned path is a CANDIDATE, not a file: an explicit ``seal_path`` is
    handed straight back, existing or not, because a named seal that is missing
    is the loudest finding in the contract rather than a lookup that failed.
    Every caller must therefore test ``exists()`` before reading it.
    """
    if seal_path is not None:
        return Path(seal_path)
    return matches[0] if len(matches) == 1 else None


def locate_seal(
    run_dir: Path,
    *,
    seal_path: Path | str | None = None,
    seal_dir: Path | str | None = None,
) -> Path | None:
    """The seal candidate for this run. See ``_select_seal`` for the contract.

    ``None`` means there is not exactly one to check against. A returned path
    may still not exist, which the caller reports rather than skips.
    """
    return _select_seal(
        seal_path, find_seals(run_dir, seal_dir=seal_dir) if seal_path is None else []
    )


def issue_record(seal: dict[str, Any] | None) -> dict[str, Any]:
    """The re-issue trace the seal carries, normalised for the report.

    Issuing supersedes a previous issue into the same directory, which is what
    makes an ordinary operator re-run survivable. It also used to erase the only
    sign that it had happened: the count went to the operator's receipt and the
    score report said nothing, so a grading session that failed a planted
    control could re-issue the run and be scored clean.

    The drill therefore stamps the counter into the seal, which lives outside
    the run directory and which the grader is not handed, and scoring reports it
    either way. A re-issue BEFORE any verdict is an ordinary action: reported,
    scoreable. A re-issue AFTER verdicts were recorded discarded work that had
    already been done, which is the move this control exists to see, and it
    voids in ``_seal_violations``.
    """
    raw = (seal or {}).get("issue")
    raw = raw if isinstance(raw, dict) else {}
    ordinal = max(_as_int(raw.get("ordinal"), 1), 1)
    return {
        "ordinal": ordinal,
        "reissued": ordinal > 1,
        "superseded_artifacts": _as_int(raw.get("superseded_artifacts"), 0),
        "verdicts_discarded_by_reissue": _as_int(raw.get("discarded_verdicts_total"), 0),
    }


def _seal_violations(
    *,
    seal: dict[str, Any] | None,
    seal_file: Path,
    run_dir: Path,
    rows: dict[str, dict[str, Any]],
    manifest: dict[str, Any],
    rules: tuple[str, ...],
    harness_path: Path,
    judge_path: Path,
) -> list[Violation]:
    """Everything the seal says changed between issue and ingest."""
    if seal is None:
        return [
            Violation(
                "no_seal",
                f"no seal for this run at {seal_file}; an unsealed run is one where "
                "tampering is undetectable by construction, so it cannot be scored",
            )
        ]

    found: list[Violation] = []
    try:
        seal_file.resolve().relative_to(run_dir.resolve())
        found.append(
            Violation(
                "seal_inside_run_dir",
                f"the seal at {seal_file} lives inside the run directory, where the "
                "grader can regenerate it; mistaking that for protection is worse "
                "than having none",
            )
        )
    except ValueError:
        pass  # outside the run directory, which is the requirement

    salt = str(seal.get("salt") or "")
    if _sha(run_dir.resolve().as_posix()) != str(seal.get("run_dir_sha256") or ""):
        found.append(
            Violation(
                "seal_run_mismatch",
                f"the seal at {seal_file} was issued for a different run directory",
            )
        )

    sealed_rows = seal.get("rows") if isinstance(seal.get("rows"), dict) else {}
    for row_id, row in sorted(rows.items()):
        expected = sealed_rows.get(row_id)
        if expected is None:
            found.append(Violation("row_hash_changed", f"row {row_id} was not in the sealed queue"))
        elif _sha(salt + _canonical_row(row)) != str(expected):
            found.append(
                Violation("row_hash_changed", f"row {row_id} was edited after it was issued")
            )
    for row_id in sorted(set(sealed_rows) - set(rows)):
        found.append(Violation("row_hash_changed", f"row {row_id} was removed from the queue"))

    controls = seal.get("controls") if isinstance(seal.get("controls"), dict) else {}
    if _sha(salt + ",".join(sorted(controls))) != str(manifest.get("controls_commitment") or ""):
        found.append(
            Violation(
                "controls_altered",
                "the set of planted rows changed after the run was issued",
            )
        )
    sealed_rules = str(seal.get("rules_sha256") or "")
    if not sealed_rules:
        found.append(
            Violation(
                "rules_altered",
                "the seal does not commit to a rule vocabulary, so a widened rule "
                "list cannot be detected and an improvised rule would pass",
            )
        )
    elif _sha(salt + ",".join(rules)) != sealed_rules:
        found.append(
            Violation(
                "rules_altered",
                "the manifest's rule vocabulary is not the one the run was sealed "
                "with; the rules being enforced are not the rules that were agreed",
            )
        )

    try:
        harness_sha = _sha(harness_path.read_text(encoding="utf-8"))
    except OSError:
        harness_sha = "<missing>"
    if harness_sha != str(seal.get("harness_sha256") or ""):
        found.append(
            Violation(
                "harness_changed",
                f"{harness_path.name} changed between issue and ingest; the rules "
                "enforced at scoring are not the rules the run was issued under",
            )
        )

    # The contract's threat table row is "Edit judge.py -- defeats the rules,
    # the controls, the void logic", and that logic lives in THIS file, not in
    # the drill. Sealing only the drill would have answered the wrong row. The
    # check is circular -- an edit here can delete it -- and the docstring says
    # so; what it buys is that an edit made without disarming the checker is
    # caught, and that an operator holding the seal can re-verify from outside.
    sealed_judge = str(seal.get("judge_sha256") or "")
    try:
        judge_sha = _sha(judge_path.read_text(encoding="utf-8"))
    except OSError:
        # Distinct from the sentinel the drill writes when it could not read the
        # module at issue time, so two unreadable ends can never agree and call
        # that a match.
        judge_sha = "<unreadable at ingest>"
    if not sealed_judge:
        found.append(
            Violation(
                "judge_changed",
                "the seal does not commit to the scoring module, so a rewritten "
                "rule, control or void check cannot be detected at all",
            )
        )
    elif judge_sha != sealed_judge:
        found.append(
            Violation(
                "judge_changed",
                f"{judge_path.name} changed between issue and ingest; the rules, the "
                "controls and the void logic at scoring are not the ones the run was "
                "issued under",
            )
        )

    # The attribution. Four manifest fields -- the suite, the run id, the issue
    # time and the ANSWERING MODEL -- are published in the report as fact, and
    # until they were sealed nothing bound any of them: the manifest is the one
    # run artifact the grader is told it may read, and editing all four
    # produced a clean, non-void report attributing the accuracy to whatever
    # model it named. The whole output of this harness is a number about a
    # named model, so a run whose attribution cannot be checked does not
    # publish one.
    if not str(seal.get("identity_sha256") or ""):
        found.append(
            Violation(
                "identity_unsealed",
                "the seal does not commit to the run's suite, run id, issue time and "
                "answering model, so the attribution printed beside the accuracy is "
                "whatever the manifest currently says and cannot be checked at all",
            )
        )
    elif not identity_is_sealed(seal, manifest):
        found.append(
            Violation(
                "identity_altered",
                "the manifest's suite, run id, issue time or answering model is not the "
                "one the run was sealed with; the accuracy would be published against an "
                "attribution the run was not issued under",
            )
        )

    # The re-issue trace. A seal with no ``issue`` record cannot say whether
    # this directory was issued once or five times, which is the same class of
    # gap as a seal that commits to no rule vocabulary: the control reads as
    # present and enforces nothing.
    raw_issue = seal.get("issue")
    if not isinstance(raw_issue, dict):
        found.append(
            Violation(
                "seal_missing_issue_record",
                "the seal records no issue counter, so a run directory that was issued "
                "again after it was graded cannot be told from one issued once",
            )
        )
    else:
        discarded = _as_int(raw_issue.get("discarded_verdicts_total"), 0)
        if discarded > 0:
            found.append(
                Violation(
                    "reissued_after_verdicts",
                    f"this run directory was issued again after {discarded} verdict(s) had "
                    "been recorded in it, and those verdicts were set aside. A re-issue "
                    "before any grading is ordinary and scores normally; one that discards "
                    "recorded verdicts is how a grading session that failed a planted "
                    "control would get a second attempt scored clean, so it cannot be. The "
                    "count carries forward across further issues, so issuing a third time "
                    "does not clear it: issue the replacement run into a NEW directory.",
                )
            )
    return found


def _blinding_record(seal: dict[str, Any] | None) -> dict[str, Any]:
    """What the seal says about the shuffle, normalised for the report.

    ``unknown`` covers a missing, unreadable, ambiguous or pre-2026-09-10 seal.
    It is reported as NOT unpredictable, because "we cannot tell" and "the
    positions were unpredictable" are different claims and only one of them is
    safe to make about a measurement.
    """
    source = str((seal or {}).get("seed_source") or "")
    if source not in (SEED_MINTED, SEED_SUPPLIED):
        source = "unknown"
    return {
        "positions_unpredictable": source == SEED_MINTED,
        "seed_source": source,
        "note": {
            SEED_MINTED: (
                "the shuffle seed was minted at issue and sealed; the planted rows' "
                "wording is still fixed in the harness, so a grader who has seen this "
                "corpus before recognises them wherever they landed"
            ),
            SEED_SUPPLIED: (
                "a seed was supplied, so the planted positions are those of every "
                "other run issued with it; this is a replay, not a blinded run"
            ),
            "unknown": (
                "the seal does not say how the shuffle seed was obtained, so nothing "
                "here can claim the planted positions were unpredictable"
            ),
        }[source],
    }


def ingest(
    *,
    run_dir: Path | str,
    seal_path: Path | str | None = None,
    seal_dir: Path | str | None = None,
    harness_path: Path | str | None = None,
    judge_path: Path | str | None = None,
    judge_label: str = "claude-code",
) -> dict[str, Any]:
    """Read the verdicts back and score the run, or void it.

    Void wins over everything. When any contract condition fires, the returned
    report carries the violations and no score field of any kind.
    """
    directory = Path(run_dir)
    queue = load_queue(directory)
    manifest = load_manifest(directory)
    rules = declared_rules(manifest)
    harness = (
        Path(harness_path)
        if harness_path is not None
        else Path(__file__).resolve().parent / HARNESS_FILENAME
    )
    judge_source = Path(judge_path) if judge_path is not None else Path(__file__).resolve()

    violations: list[Violation] = []

    # 0. The manifest is the one run artifact the grader is told it may read,
    #    so what it may not carry is a control, not a convention.
    for key in sorted(set(manifest) & set(MANIFEST_FORBIDDEN_KEYS)):
        violations.append(
            Violation(
                "manifest_leaks_controls",
                f"{MANIFEST_FILENAME} carries {key!r}: {MANIFEST_FORBIDDEN_KEYS[key]} Any holder "
                "of the manifest could therefore name the planted rows, and the grader is told "
                "the manifest is readable, so the blinding this run reports cannot be assumed. "
                "Re-issue with a harness that seals it.",
            )
        )

    # 1. The evidence must be the evidence that was issued. Two layers: the
    #    in-run hash catches a plain edit, and the seal's salted hash catches an
    #    edit where the in-run hashes were updated to match.
    issued = manifest.get("hashes") if isinstance(manifest.get("hashes"), dict) else {}
    for row_id, row in sorted(queue.items()):
        expected = issued.get(row_id)
        if expected is None:
            violations.append(
                Violation("row_hash_changed", f"row {row_id} has no issued hash in the manifest")
            )
        elif _sha(_canonical_row(row)) != str(expected):
            violations.append(
                Violation(
                    "row_hash_changed",
                    f"row {row_id} does not match the hash it was issued with",
                )
            )
    for row_id in sorted(set(issued) - set(queue)):
        violations.append(
            Violation("row_hash_changed", f"row {row_id} is missing from the queue file")
        )

    # 2. The verdicts: one per row, every row, appended through the writer.
    entries = read_verdicts(directory)
    verdicts: dict[str, dict[str, Any]] = {}
    for entry in entries:
        row_id = str(entry.get("id"))
        if row_id in verdicts:
            violations.append(
                Violation(
                    "duplicate_verdict",
                    f"row {row_id} was graded more than once; a revision is not a verdict",
                )
            )
        verdicts[row_id] = entry

    # An uncited `wrong` is discarded, per the contract, because it is
    # indistinguishable from a hallucinated one. A DISCARDED verdict leaves its
    # row ungraded, and ungraded rows void the run: dropping the row from the
    # denominator instead would hand every grader a free way to raise its own
    # accuracy, by appending an uncited `wrong` to any row it could not defend.
    # The honest verdict for a call you cannot quote is `unsure`, which the
    # contract makes count against accuracy precisely so hedging is not free.
    discarded = discarded_verdicts(queue, verdicts)
    if discarded:
        violations.append(
            Violation(
                "uncited_wrong_discarded",
                f"{len(discarded)} `wrong` verdict(s) quote nothing in their row and are "
                "discarded, which leaves those rows ungraded: "
                + ", ".join(discarded[:8])
                + ("..." if len(discarded) > 8 else "")
                + ". A call that cannot be quoted is `unsure`, not a row removed from the "
                "denominator",
            )
        )
    ungraded = sorted(set(queue) - (set(verdicts) - set(discarded)))
    if ungraded:
        # A partial pass would let a grader raise accuracy by skipping the rows
        # it found hard.
        violations.append(
            Violation(
                "rows_ungraded",
                f"{len(ungraded)} of {len(queue)} rows were not graded: "
                + ", ".join(ungraded[:8])
                + ("..." if len(ungraded) > 8 else ""),
            )
        )
    for row_id in sorted(set(verdicts) - set(queue)):
        violations.append(
            Violation(
                "unknown_row_graded", f"a verdict names row {row_id}, which is not in the queue"
            )
        )

    for position, entry in enumerate(entries, start=1):
        if str(entry.get("chain") or "") != chain_head(entries[:position]):
            violations.append(
                Violation(
                    "verdict_chain_broken",
                    f"verdict {position} (row {entry.get('id')}) breaks the chain; it was "
                    "revised, reordered, or appended past the validating writer",
                )
            )
            break

    # The chain validates a PREFIX, so on its own it cannot see a verdict that
    # was deleted: truncate the file, re-record through the sanctioned writer,
    # and every remaining line still chains. The write ledger is the second
    # record that makes the deletion visible, and it is also what catches a line
    # appended past the writer with a recomputed chain.
    ledger = read_write_ledger(directory)
    if len(ledger) > len(entries):
        violations.append(
            Violation(
                "verdict_removed",
                f"the writer recorded {len(ledger)} verdicts and {VERDICTS_FILENAME} holds "
                f"{len(entries)}; a verdict that was written is gone, and a verdict deleted "
                "so it can be given again is a revision",
            )
        )
    elif len(ledger) < len(entries):
        violations.append(
            Violation(
                "verdict_appended_past_writer",
                f"{VERDICTS_FILENAME} holds {len(entries)} verdicts but the writer recorded "
                f"{len(ledger)}; the extra lines never passed the citation, rule and "
                "duplicate checks the writer applies",
            )
        )
    for position, (entry, head) in enumerate(zip(entries, ledger, strict=False), start=1):
        if str(entry.get("chain") or "") != head:
            violations.append(
                Violation(
                    "verdict_chain_broken",
                    f"verdict {position} (row {entry.get('id')}) is not the verdict the "
                    "writer recorded in that position",
                )
            )
            break

    # 3. A `wrong` may only cite a rule this run declared.
    for row_id, entry in sorted(verdicts.items()):
        rule = str(entry.get("rule") or "")
        if str(entry.get("verdict")) == VERDICT_WRONG and rule not in rules:
            violations.append(
                Violation(
                    "unknown_rule_cited",
                    f"the verdict for {row_id} cites rule {rule or '(none)'!r}, which this "
                    "run does not define",
                )
            )

    # 4. The seal, which is also the only place the control answers live. It is
    #    found by searching, never by a name the run directory publishes.
    root = seal_search_root(directory, seal_dir)
    matches = [] if seal_path is not None else find_seals(directory, seal_dir=seal_dir)
    ambiguous = len(matches) > 1
    if ambiguous:
        violations.append(
            Violation(
                "ambiguous_seal",
                f"{len(matches)} seals under {root} claim this run directory, and nothing "
                "here can say which one was issued with it. Exactly one is live per run: "
                "issuing the drill into a directory that already held a run supersedes the "
                "previous seal rather than leaving it, so a second live seal is one that "
                "was copied or planted. Recover by issuing the run again, which retires "
                "the stale seals and writes a fresh queue, then grade and score that run. "
                "Do not remove a seal by hand: deleting a seal is the act this control "
                "exists to detect, and an operator who does it cannot later be told apart "
                "from a grader who did.",
            )
        )
    seal_file = _select_seal(seal_path, matches)
    try:
        seal = _read_json(seal_file) if seal_file is not None and seal_file.exists() else None
    except JudgeError:
        # A seal nothing can parse protects nothing, which is the same finding
        # as no seal at all rather than a reason to stop reading the run.
        seal = None
    if not ambiguous:
        # With two live seals the run is already void, and its finding is the
        # accurate one. Reporting `no_seal` beside it would be a second and
        # false statement about the same fact, and checking the rows against a
        # seal chosen by sort order would accuse the operator of tampering for
        # having run the drill twice.
        violations.extend(
            _seal_violations(
                seal=seal,
                seal_file=seal_file if seal_file is not None else root,
                run_dir=directory,
                rows=queue,
                manifest=manifest,
                rules=rules,
                harness_path=harness,
                judge_path=judge_source,
            )
        )
    controls = (seal or {}).get("controls")
    controls = controls if isinstance(controls, dict) else {}

    # 5. Grade what is left, and check the controls.
    counted: list[str] = []
    discarded_ids = set(discarded)
    negative_caught = 0
    negative_total = 0
    positive_passed = 0
    positive_total = 0
    failures: list[dict[str, Any]] = []
    rule_mismatches: list[dict[str, str]] = []
    for row_id in sorted(queue):
        entry = verdicts.get(row_id)
        if entry is None:
            continue
        verdict = str(entry.get("verdict") or "")
        citation = str(entry.get("citation") or "")
        control = controls.get(row_id) if isinstance(controls.get(row_id), dict) else None
        # A `wrong` whose citation quotes nothing was discarded above, so it
        # flags nothing: an uncited flag on a planted row is indistinguishable
        # from a lucky guess, and the contract will not count a guess as a catch.
        flagged = verdict == VERDICT_WRONG and row_id not in discarded_ids
        if control is not None:
            kind = str(control.get("kind") or "")
            if kind == "negative":
                negative_total += 1
                negative_caught += int(flagged)
                planted_rule = str(control.get("rule") or "")
                cited_rule = str(entry.get("rule") or "")
                # Reported, never voided. The seal knows which rule was planted
                # and ingest used to ignore it entirely, so a grader could flag
                # a control for the wrong reason and still score 4/4. A mismatch
                # is real signal about the grader, but it is not proof of a bad
                # call: a row planted as `stale-value` may honestly also read as
                # `wrong-value`, and voiding on that would punish judgement.
                if flagged and planted_rule and cited_rule != planted_rule:
                    rule_mismatches.append(
                        {"id": row_id, "planted": planted_rule, "cited": cited_rule}
                    )
                if not flagged:
                    violations.append(
                        Violation(
                            "negative_control_passed",
                            f"row {row_id} is a planted failure the grader passed; a grader "
                            "that is not reading has said nothing worth having",
                        )
                    )
            if kind == "positive":
                positive_total += 1
                positive_passed += int(not flagged)
                if flagged:
                    violations.append(
                        Violation(
                            "positive_control_flagged",
                            f"row {row_id} is a known-good answer the grader flagged; a grader "
                            "that over-flags produces failures nobody can act on",
                        )
                    )
            continue  # controls never enter the score
        if row_id in discarded_ids:
            # Already voided above as an ungraded row. Nothing to score.
            continue
        counted.append(verdict)
        if verdict == VERDICT_WRONG:
            failures.append(
                {
                    "id": row_id,
                    "rule": str(entry.get("rule") or ""),
                    "citation": citation,
                    "note": str(entry.get("note") or ""),
                }
            )

    report: dict[str, Any] = {
        "suite": str(manifest.get("suite") or ""),
        "run_id": str(manifest.get("run_id") or ""),
        # Read back from the manifest, never stamped here: scoring must be
        # reproducible, so it owns no clock.
        "created_at": str(manifest.get("created_at") or ""),
        "answerer_model": str(manifest.get("answerer_model") or "unknown"),
        "judge_label": judge_label,
        "rows": len(queue),
        # Which issue into this run directory produced the rows being scored,
        # and what a re-issue set aside. Present on every report, scored or
        # void, because the operator's receipt is not a place a reader of the
        # score can check. ``ordinal`` reads 1 when the seal is ambiguous or
        # missing, and those void on their own findings.
        "issue": issue_record(seal),
        # Whether the four identity fields above are the ones the run was
        # sealed under. False also voids, via ``_seal_violations``; it is
        # stated here as well so a reader of the report never has to infer an
        # attribution's standing from the absence of a violation.
        "identity_verified": identity_is_sealed(seal, manifest),
        # Whether this run's planted positions were unpredictable. The seed is
        # minted per issue by default and sealed; a run issued with an explicit
        # seed has the positions of every other run issued with that seed, and
        # says so here rather than being counted as blind. Neither answer is a
        # void: replaying an issue is a legitimate operator action, and what
        # would not be legitimate is reporting it as a blinded measurement.
        "blinding": _blinding_record(seal),
        "void": bool(violations),
        "violations": [violation.to_dict() for violation in violations],
        # A discipline, not an enforced property: no script can ask a session
        # whether it is the one that planted the controls.
        "context_separation": {
            "enforced": False,
            "note": "grade in a session that did not write the queue",
        },
    }
    if violations:
        # A void run publishes NO accuracy at all. Not a number with a caveat:
        # a number with a caveat gets quoted without the caveat. There is no
        # score field here to quote.
        report["accuracy"] = None
        report["quality_judged_independently"] = False
        return report

    correct = counted.count(VERDICT_CORRECT)
    report.update(
        {
            "graded": len(counted),
            "correct": correct,
            # `unsure` counts against accuracy. Treating it as a pass would let
            # a hedging judge inflate the score for free.
            "unsure": counted.count(VERDICT_UNSURE),
            "wrong": len(failures),
            "accuracy": round(correct / len(counted), 4) if counted else None,
            "negative_controls_caught": f"{negative_caught}/{negative_total}",
            "positive_controls_passed": f"{positive_passed}/{positive_total}",
            # Diagnostic only, and empty on a clean run: the grader caught the
            # planted row but named a different rule than the one planted.
            "negative_control_rule_mismatches": rule_mismatches,
            "failures": failures,
            "quality_judged_independently": True,
        }
    )
    return report


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run-dir", required=True, help="the directory holding the review queue")
    sub = parser.add_subparsers(dest="command", required=True)

    recorder = sub.add_parser("record", help="append one validated verdict")
    recorder.add_argument("--id", required=True, help="the queue row id")
    recorder.add_argument("--verdict", required=True, choices=list(VERDICTS))
    recorder.add_argument("--rule", default="", help="required for a `wrong` verdict")
    recorder.add_argument("--citation", default="", help="the offending value, quoted verbatim")
    recorder.add_argument("--note", default="", help="one sentence")

    scorer = sub.add_parser("ingest", help="score the run, or void it")
    scorer.add_argument("--seal", help="the seal file; defaults to the run's own seal")
    scorer.add_argument("--seal-dir", help="where seals live; must be outside the run directory")
    scorer.add_argument("--harness", help="the harness source the run was sealed against")
    scorer.add_argument("--judge-source", help="the scoring module the run was sealed against")
    scorer.add_argument("--judge-label", default="claude-code")
    scorer.add_argument("--report-path", help="write the report JSON here")

    replayer = sub.add_parser(
        "replay",
        help="put a read-only grader's verdict JSONL through the same validated writer",
    )
    replayer.add_argument(
        "--from",
        dest="submission",
        help="the grader's JSONL file; omit to read it from stdin",
    )

    sub.add_parser("progress", help="how many rows remain ungraded")

    args = parser.parse_args(argv)
    try:
        if args.command == "record":
            entry = record(
                run_dir=args.run_dir,
                row_id=args.id,
                verdict=args.verdict,
                rule=args.rule,
                citation=args.citation,
                note=args.note,
            )
            print(json.dumps(entry, sort_keys=True))
            return 0
        if args.command == "ingest":
            report = ingest(
                run_dir=args.run_dir,
                seal_path=args.seal,
                seal_dir=args.seal_dir,
                harness_path=args.harness,
                judge_path=args.judge_source,
                judge_label=args.judge_label,
            )
            rendered = json.dumps(report, indent=2, sort_keys=True)
            print(rendered)
            if args.report_path:
                Path(args.report_path).write_text(rendered + "\n", encoding="utf-8")
            return 1 if report["void"] else 0
        if args.command == "replay":
            outcome = replay(run_dir=args.run_dir, rows=read_submission(args.submission))
            print(json.dumps(outcome, indent=2, sort_keys=True))
            return 0
        state = progress(args.run_dir)
        print(json.dumps(state, indent=2, sort_keys=True))
        return 0 if state["complete"] else 1
    except JudgeError as exc:
        # Loud, and on stderr: a judge that cannot tell a rejection from a
        # success will move on believing the row is graded.
        print(f"rejected: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

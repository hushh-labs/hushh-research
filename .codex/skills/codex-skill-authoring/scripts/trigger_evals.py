#!/usr/bin/env python3
"""trigger_evals.py — deterministic skill-routing evals for the .codex fleet.

Ported from addyosmani/agent-skills run-evals.js (Tier 2) and adapted to the
hushh-research skill contract (skill.json manifests + SKILL.md frontmatter).

What it checks (zero tokens, CI-safe, stdlib only):

  1. Trigger evals — for every case file in .codex/evals/cases/<skill>.json,
     each positive prompt must rank the skill within top_k (default 3) when
     scored against every skill description; each negative prompt must NOT
     rank it #1. A negative may declare an "owner" skill that must outrank
     this one for the prompt (pairwise routing test — prevents vacuous passes
     where the prompt matches nothing at all).

  2. Routing collisions — no two skill descriptions may be near-duplicates
     (cosine similarity of TF-IDF vectors). Same-owner-family pairs are held
     to a looser threshold because sibling spokes legitimately share domain
     vocabulary.

Exit codes: 0 = all clear, 1 = one or more errors.

Usage:
  python3 .codex/skills/codex-skill-authoring/scripts/trigger_evals.py [--text]
  python3 .codex/skills/codex-skill-authoring/scripts/trigger_evals.py --json
"""

from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter, OrderedDict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
SKILLS_ROOT = REPO_ROOT / ".codex" / "skills"
CASES_DIR = REPO_ROOT / ".codex" / "evals" / "cases"

DEFAULT_TOP_K = 3

# Cosine-similarity thresholds for description collisions.
COLLISION_ERROR = 0.75
COLLISION_WARN = 0.50
# Sibling spokes in one owner family share domain vocabulary by design;
# only flag them at the error threshold.
SAME_FAMILY_WARN = 0.75

# Documented minimums per case file (warning-level).
MIN_POSITIVE = 3
MIN_NEGATIVE = 2

STOPWORDS = {
    "a", "an", "and", "any", "are", "as", "at", "be", "before", "by", "for",
    "from", "in", "into", "is", "it", "its", "my", "need", "needs", "of", "on",
    "or", "our", "so", "that", "the", "them", "this", "to", "use", "want",
    "we", "when", "with", "you", "your", "help", "me", "i",
}


def stem(token: str) -> str:
    """Light suffix stripping so related word forms cluster. Not a real stemmer."""
    for suffix in ("ally", "ing", "ed", "es", "al"):
        if len(token) > len(suffix) + 3 and token.endswith(suffix):
            token = token[: -len(suffix)]
            break
    if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
        token = token[:-1]
    if len(token) > 4 and token.endswith("e"):
        token = token[:-1]
    # Collapse doubled trailing consonant left by -ing/-ed ("committ" -> "commit").
    if len(token) > 4 and token[-1] == token[-2] and token[-1] not in "aeiou":
        token = token[:-1]
    # Normalize trailing y so "simplify"/"simplified" cluster.
    if len(token) > 3 and token.endswith("y"):
        token = token[:-1] + "i"
    return token


def tokenize(text: str) -> list[str]:
    cleaned = re.sub(r"[^a-z0-9\s-]", " ", text.lower())
    return [
        stem(t)
        for t in re.split(r"[\s-]+", cleaned)
        if len(t) > 2 and t not in STOPWORDS
    ]


def load_skills() -> list[dict]:
    """Skill id + description + owner_family from skill.json (fallback: SKILL.md frontmatter)."""
    skills = []
    for manifest in sorted(SKILLS_ROOT.glob("*/skill.json")):
        try:
            data = json.loads(manifest.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        skill_id = data.get("id") or manifest.parent.name
        description = (data.get("description") or "").strip()
        if not description:
            skill_md = manifest.parent / "SKILL.md"
            if skill_md.exists():
                match = re.search(
                    r"^description:\s*(.+)$", skill_md.read_text(), re.MULTILINE
                )
                if match:
                    description = match.group(1).strip()
        if description:
            skills.append(
                {
                    "id": skill_id,
                    "description": description,
                    "owner_family": data.get("owner_family") or skill_id,
                }
            )
    return skills


def build_corpus(skills: list[dict]) -> dict:
    """TF per skill doc (name tokens weighted 2x) + IDF over the corpus."""
    docs: "OrderedDict[str, Counter]" = OrderedDict()
    for skill in skills:
        name_tokens = tokenize(skill["id"].replace("-", " "))
        tokens = name_tokens * 2 + tokenize(skill["description"])
        docs[skill["id"]] = Counter(tokens)
    df: Counter = Counter()
    for tf in docs.values():
        df.update(tf.keys())
    n = len(docs)

    def idf(term: str) -> float:
        return math.log(1 + n / (1 + df.get(term, 0)))

    return {"docs": docs, "idf": idf}


def _vec(tf: Counter, idf) -> dict[str, float]:
    return {term: freq * idf(term) for term, freq in tf.items()}


def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    dot = sum(w * b[t] for t, w in a.items() if t in b)
    na = math.sqrt(sum(w * w for w in a.values()))
    nb = math.sqrt(sum(w * w for w in b.values()))
    if not na or not nb:
        return 0.0
    return dot / (na * nb)


def rank_skills(prompt: str, corpus: dict) -> list[tuple[str, float]]:
    pv = _vec(Counter(tokenize(prompt)), corpus["idf"])
    scores = [
        (name, _cosine(pv, _vec(tf, corpus["idf"])))
        for name, tf in corpus["docs"].items()
    ]
    scores.sort(key=lambda item: item[1], reverse=True)
    return scores


def load_cases() -> list[dict]:
    cases = []
    if not CASES_DIR.exists():
        return cases
    for case_file in sorted(CASES_DIR.glob("*.json")):
        entry = {"file": case_file.name}
        try:
            entry["data"] = json.loads(case_file.read_text())
        except json.JSONDecodeError as exc:
            entry["parse_error"] = str(exc)
        cases.append(entry)
    return cases


def run(as_json: bool = False) -> int:
    skills = load_skills()
    cases = load_cases()
    corpus = build_corpus(skills)
    skill_ids = {s["id"] for s in skills}
    family = {s["id"]: s["owner_family"] for s in skills}

    errors: list[str] = []
    warnings: list[str] = []
    passed = 0
    rank1 = 0
    positives = 0

    covered = {c["file"].removesuffix(".json") for c in cases}
    for skill in skills:
        if skill["id"] not in covered:
            warnings.append(f"no eval case file for {skill['id']}")

    for case in cases:
        if "parse_error" in case:
            errors.append(f"{case['file']}: invalid JSON — {case['parse_error']}")
            continue
        data = case["data"]
        expected = case["file"].removesuffix(".json")
        if data.get("skill_name") != expected:
            errors.append(
                f"{case['file']}: skill_name {data.get('skill_name')!r} does not match filename"
            )
        if expected not in skill_ids:
            errors.append(f"{case['file']}: no such skill directory")
            continue

        trigger = data.get("trigger", {})
        for positive in trigger.get("positive", []):
            positives += 1
            top_k = positive.get("top_k", DEFAULT_TOP_K)
            ranking = rank_skills(positive["prompt"], corpus)
            idx = next(
                (i for i, (name, _) in enumerate(ranking) if name == expected), -1
            )
            score = ranking[idx][1] if idx >= 0 else 0.0
            if idx == 0 and score > 0:
                rank1 += 1
            if 0 <= idx < top_k and score > 0:
                passed += 1
            elif score == 0:
                errors.append(
                    f"{expected}: description shares no vocabulary with prompt "
                    f"\"{positive['prompt']}\""
                )
            else:
                top3 = ", ".join(
                    f"{name} ({s:.2f})" for name, s in ranking[:3] if s > 0
                )
                errors.append(
                    f"{expected}: positive prompt ranked #{idx + 1} (need top {top_k}) "
                    f"— \"{positive['prompt']}\" — top3: {top3}"
                )

        for negative in trigger.get("negative", []):
            ranking = rank_skills(negative["prompt"], corpus)
            ok = True
            if ranking[0][0] == expected and ranking[0][1] > 0:
                errors.append(
                    f"{expected}: ranked #1 for negative prompt (over-broad description) "
                    f"— \"{negative['prompt']}\""
                )
                ok = False
            owner = negative.get("owner")
            if owner:
                if owner not in skill_ids:
                    errors.append(
                        f"{case['file']}: negative declares unknown owner {owner!r}"
                    )
                    ok = False
                else:
                    owner_idx = next(
                        i for i, (name, _) in enumerate(ranking) if name == owner
                    )
                    self_idx = next(
                        i for i, (name, _) in enumerate(ranking) if name == expected
                    )
                    if ranking[owner_idx][1] == 0 or owner_idx > self_idx:
                        errors.append(
                            f"{expected}: declared owner {owner} does not outrank it "
                            f"for negative prompt \"{negative['prompt']}\" "
                            f"(owner #{owner_idx + 1} @ {ranking[owner_idx][1]:.2f}, "
                            f"self #{self_idx + 1})"
                        )
                        ok = False
            if ok:
                passed += 1

        pc = len(trigger.get("positive", []))
        nc = len(trigger.get("negative", []))
        if pc < MIN_POSITIVE or nc < MIN_NEGATIVE:
            warnings.append(
                f"{expected}: below documented minimums "
                f"({pc} positive/{nc} negative; need {MIN_POSITIVE}/{MIN_NEGATIVE})"
            )

    # Routing collisions across the catalog.
    names = list(corpus["docs"].keys())
    for i, name_a in enumerate(names):
        vec_a = _vec(corpus["docs"][name_a], corpus["idf"])
        for name_b in names[i + 1 :]:
            sim = _cosine(vec_a, _vec(corpus["docs"][name_b], corpus["idf"]))
            same_family = family.get(name_a) == family.get(name_b)
            if sim >= COLLISION_ERROR:
                errors.append(
                    f"collision: {name_a} <-> {name_b} descriptions {sim * 100:.0f}% similar"
                )
            elif sim >= (SAME_FAMILY_WARN if same_family else COLLISION_WARN):
                warnings.append(
                    f"overlap: {name_a} <-> {name_b} descriptions {sim * 100:.0f}% similar"
                )

    rank1_rate = f"{(rank1 / positives * 100):.0f}%" if positives else "n/a"
    if as_json:
        print(
            json.dumps(
                OrderedDict(
                    status="failed" if errors else "ok",
                    skills=len(skills),
                    case_files=len(cases),
                    checks_passed=passed,
                    errors=errors,
                    warnings=warnings,
                    rank1_rate=rank1_rate,
                ),
                indent=2,
            )
        )
    else:
        print(f"Trigger evals: {len(skills)} skills, {len(cases)} case files")
        for message in errors:
            print(f"  ERROR: {message}")
        for message in warnings:
            print(f"  WARN:  {message}")
        print(
            f"{passed} checks passed — {len(errors)} error(s), {len(warnings)} warning(s)"
        )
        print(f"trigger rank-1 rate: {rank1_rate} ({rank1}/{positives} positives rank #1)")
        print("FAILED" if errors else "PASSED")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(run(as_json="--json" in sys.argv[1:]))

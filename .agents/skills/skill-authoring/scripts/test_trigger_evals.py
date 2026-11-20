#!/usr/bin/env python3
"""Unit tests for trigger_evals.py — run directly: python3 test_trigger_evals.py"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import trigger_evals as te  # noqa: E402

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok  {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILURES.append(name)


def test_stemmer_clusters() -> None:
    check("stem conflicts->conflict", te.stem("conflicts") == te.stem("conflict"))
    check("stem branching->branch", te.stem("branching") == te.stem("branch"))
    check("stem committed~commit", te.stem("committed") == te.stem("commit"))
    check(
        "stem simplify~simplified",
        te.stem("simplify") == te.stem("simplified"),
        f"({te.stem('simplify')} vs {te.stem('simplified')})",
    )


def test_tokenize_stopwords() -> None:
    tokens = te.tokenize("Use this when the user wants to review a PR")
    check("stopwords removed", "the" not in tokens and "use" not in tokens)
    check("content words kept", any("review" in t for t in tokens))


def _synthetic_corpus() -> dict:
    skills = [
        {
            "id": "pr-review",
            "description": "Review pull requests for merge readiness and blocker gates.",
            "owner_family": "pr-review",
        },
        {
            "id": "schema-migration",
            "description": "Plan database schema migrations with expand contract phases.",
            "owner_family": "schema-migration",
        },
        {
            "id": "voice-runtime",
            "description": "Voice action runtime governance for Kai speech surfaces.",
            "owner_family": "voice-runtime",
        },
    ]
    return te.build_corpus(skills)


def test_rank_ordering() -> None:
    corpus = _synthetic_corpus()
    ranking = te.rank_skills("review this pull request before merge", corpus)
    check("pr prompt ranks pr-review #1", ranking[0][0] == "pr-review", str(ranking))
    ranking = te.rank_skills("add a column to the database schema", corpus)
    check(
        "schema prompt ranks schema-migration #1",
        ranking[0][0] == "schema-migration",
        str(ranking),
    )


def test_cosine_bounds() -> None:
    corpus = _synthetic_corpus()
    idf = corpus["idf"]
    a = te._vec(corpus["docs"]["pr-review"], idf)
    check("self-similarity == 1", abs(te._cosine(a, a) - 1.0) < 1e-9)
    b = te._vec(corpus["docs"]["voice-runtime"], idf)
    sim = te._cosine(a, b)
    check("cross-similarity in [0,1)", 0.0 <= sim < 1.0, f"sim={sim}")
    check("empty vec -> 0", te._cosine({}, a) == 0.0)


def test_zero_score_prompt() -> None:
    corpus = _synthetic_corpus()
    ranking = te.rank_skills("zzz qqq xxx", corpus)
    check("unrelated prompt scores 0", all(s == 0.0 for _, s in ranking))


def test_name_token_weighting() -> None:
    # Name tokens are counted twice, so an id term should dominate its own doc.
    corpus = _synthetic_corpus()
    doc = corpus["docs"]["voice-runtime"]
    check("name token weighted 2x+", doc[te.stem("voice")] >= 2, str(doc))


def test_real_fleet_loads() -> None:
    skills = te.load_skills()
    check("real fleet loads 20+ skills", len(skills) >= 20, f"got {len(skills)}")
    check(
        "every skill has description",
        all(s["description"] for s in skills),
    )
    corpus = te.build_corpus(skills)
    check("corpus covers fleet", len(corpus["docs"]) == len(skills))


def main() -> int:
    for fn in (
        test_stemmer_clusters,
        test_tokenize_stopwords,
        test_rank_ordering,
        test_cosine_bounds,
        test_zero_score_prompt,
        test_name_token_weighting,
        test_real_fleet_loads,
    ):
        print(fn.__name__)
        fn()
    print(f"\n{'FAILED' if FAILURES else 'PASSED'} ({len(FAILURES)} failure(s))")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())

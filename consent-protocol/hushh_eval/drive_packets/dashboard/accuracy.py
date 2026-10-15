"""/api/accuracy: what the AI claims next to what the founder found, and where they meet.

Packets
  ai     the eval judges' final verdicts on the owner's Ready packets, every batch
         (deterministic failure, else J1/J2 consensus; pass = correct, fail = wrong,
         anything else = undecided). A person's verdict in the eval is not AI.
  human  the founder's newest Correct / Wrong / Not sure label per UAT packet.
  agreement  packets judged by both: a UAT packet whose member documents are
         exactly an eval packet's (``EvalVerdicts``) and that the founder labeled
         Correct or Wrong.
Requests (dry runs and real requests)
  system_selected  documents the engine selected as matching.
  human  the founder's newest Right / Wrong / Not sure / Missed per document;
         precision = right / (right + wrong); a Missed is a document the founder
         says should have matched (the recall proxy).
  agreement  documents with both a system claim and a Right / Wrong / Missed label.
Every number carries its sample size, and the bars are the eval's exact
zero-failure sample sizes (stats.py): 59 for 95%, 2,995 for 99.9%.
"""

from __future__ import annotations

from collections import Counter

from hushh_eval.drive_packets.stats import summary, zero_failure_sample_size

AI_WORDS = {"pass": "correct", "fail": "wrong"}


def bars() -> dict:
    return {"n95": zero_failure_sample_size(0.95), "n999": zero_failure_sample_size(0.999)}


def _bound(successes: int, trials: int) -> float | None:
    return summary(successes, trials)["cp_lower_95"] if trials else None


def packet_accuracy(
    eval_ready: list[dict], human_labels: dict[str, dict], served_ai: dict[str, str | None]
) -> dict:
    """eval_ready: [{batch, packet_key, ai: pass|fail|unknown}];
    human_labels: {packet_id: {verdict: correct|wrong|unsure, ...}};
    served_ai: {packet_id: correct|wrong|undecided|None} for the owner's UAT packets."""
    ai = Counter(AI_WORDS.get(row.get("ai"), "undecided") for row in eval_ready)
    by_batch: dict[str, Counter] = {}
    for row in eval_ready:
        by_batch.setdefault(row.get("batch") or "?", Counter())[
            AI_WORDS.get(row.get("ai"), "undecided")
        ] += 1
    human = Counter(
        record.get("verdict")
        for record in human_labels.values()
        if record.get("verdict") in {"correct", "wrong", "unsure"}
    )
    both = agree = 0
    disagreements = []
    for packet_id, record in sorted(human_labels.items()):
        mine, theirs = record.get("verdict"), served_ai.get(packet_id)
        if mine not in {"correct", "wrong"} or theirs not in {"correct", "wrong"}:
            continue
        both += 1
        if mine == theirs:
            agree += 1
        else:
            disagreements.append({"packet_id": packet_id, "ai": theirs, "human": mine})
    decided_ai = ai["correct"] + ai["wrong"]
    decided_human = human["correct"] + human["wrong"]
    return {
        "ai": {
            "correct": ai["correct"],
            "wrong": ai["wrong"],
            "undecided": ai["undecided"],
            "n": sum(ai.values()),
            "lower_bound_95": _bound(ai["correct"], decided_ai),
            "by_batch": {
                batch: {
                    "correct": counts["correct"],
                    "wrong": counts["wrong"],
                    "undecided": counts["undecided"],
                    "n": sum(counts.values()),
                }
                for batch, counts in sorted(by_batch.items())
            },
            "unit": "eval Ready packet version (all batches)",
        },
        "human": {
            "correct": human["correct"],
            "wrong": human["wrong"],
            "unsure": human["unsure"],
            "n": sum(human.values()),
            "lower_bound_95": _bound(human["correct"], decided_human),
            "unit": "UAT packet labeled by the founder",
        },
        "agreement": {
            "both": both,
            "agree": agree,
            "disagree": len(disagreements),
            "disagreements": disagreements,
            "served_packets_with_ai_verdict": sum(
                value in {"correct", "wrong", "undecided"} for value in served_ai.values()
            ),
        },
        "bars": bars(),
    }


def document_key(document: dict, index: int) -> str:
    """How a label names a document: its id, else its search position, else its row."""
    value = document.get("document_id")
    if isinstance(value, str) and value:
        return value
    if isinstance(document.get("position"), int):
        return f"p{document['position']}"
    value = document.get("file_id")
    if isinstance(value, str) and value:
        return value
    return f"#{index}"


def document_claims(documents: list[dict]) -> dict[str, dict]:
    """{document key: {selected, dates_proven}} from an ask's or a request's documents.

    The engine's own ``period_proven`` wins when present; otherwise a selected
    document needs a content period and no "selected without content dates" flag.
    """
    claims = {}
    for index, document in enumerate(documents or []):
        if not isinstance(document, dict):
            continue
        selected = document.get("selected") is True
        if isinstance(document.get("period_proven"), bool):
            proven = selected and document["period_proven"]
        else:
            proven = bool(
                selected
                and document.get("period_start")
                and document.get("period_end")
                and document.get("period_role") in {None, "content_period"}
                and "selected_without_content_dates" not in (document.get("flags") or [])
            )
        claims[document_key(document, index)] = {"selected": selected, "dates_proven": proven}
    return claims


def _request_side(items: list[tuple[str, dict[str, dict], dict]]) -> dict:
    """items: (subject id, claims by document, {document_id: label record}).

    Precision counts only labels on documents the system selected. A Missed label,
    or a Wrong label on a document the system left out, is a miss (recall proxy).
    """
    selected = proven = 0
    verdicts = Counter()
    right_selected = wrong_selected = missed = 0
    both = agree = 0
    disagreements = []
    subjects_labeled = 0
    for subject, claims, labels in items:
        selected += sum(claim["selected"] for claim in claims.values())
        proven += sum(claim["dates_proven"] for claim in claims.values())
        if labels:
            subjects_labeled += 1
        for key, record in labels.items():
            verdict = record.get("verdict")
            if key is None or verdict not in {"right", "wrong", "unsure", "missed"}:
                continue
            verdicts[verdict] += 1
            claim = claims.get(key)
            chosen = bool(claim and claim["selected"])
            if verdict == "right" and chosen:
                right_selected += 1
            elif verdict == "wrong" and chosen:
                wrong_selected += 1
            elif verdict == "missed" or (verdict == "wrong" and claim and not chosen):
                missed += 1
            if claim is None or verdict == "unsure" or (verdict == "missed" and chosen):
                continue
            both += 1
            if verdict == "right":
                agree += 1
            else:
                disagreements.append(
                    {
                        "subject": subject,
                        "document_id": key,
                        "system": "selected" if chosen else "not selected",
                        "human": verdict,
                    }
                )
    judged = right_selected + wrong_selected
    return {
        "system_selected": selected,
        "system_selected_dates_proven": proven,
        "human": {
            "right": verdicts["right"],
            "wrong": verdicts["wrong"],
            "unsure": verdicts["unsure"],
            "missed": verdicts["missed"],
            "n": sum(verdicts.values()),
            "right_on_selected": right_selected,
            "wrong_on_selected": wrong_selected,
            "precision": right_selected / judged if judged else None,
            "precision_lower_bound_95": _bound(right_selected, judged),
            "misses": missed,
            "recall_proxy": right_selected / (right_selected + missed)
            if right_selected + missed
            else None,
        },
        "agreement": {
            "both": both,
            "agree": agree,
            "disagree": len(disagreements),
            "disagreements": disagreements[:200],
        },
        "subjects": len(items),
        "subjects_labeled": subjects_labeled,
    }


def request_accuracy(
    dry_runs: list[tuple[str, list[dict], dict]], real: list[tuple[str, list[dict], dict]]
) -> dict:
    """dry_runs / real: (ask or request id, documents, {document_id: label record})."""
    by_source = {
        "dry_run": _request_side(
            [(sid, document_claims(docs), labels) for sid, docs, labels in dry_runs]
        ),
        "real": _request_side([(sid, document_claims(docs), labels) for sid, docs, labels in real]),
    }
    human = Counter()
    for side in by_source.values():
        for key in (
            "right",
            "wrong",
            "unsure",
            "missed",
            "right_on_selected",
            "wrong_on_selected",
            "misses",
        ):
            human[key] += side["human"][key]
    judged = human["right_on_selected"] + human["wrong_on_selected"]
    return {
        "system_selected": sum(side["system_selected"] for side in by_source.values()),
        "system_selected_dates_proven": sum(
            side["system_selected_dates_proven"] for side in by_source.values()
        ),
        "human": {
            "right": human["right"],
            "wrong": human["wrong"],
            "unsure": human["unsure"],
            "missed": human["missed"],
            "n": human["right"] + human["wrong"] + human["unsure"] + human["missed"],
            "right_on_selected": human["right_on_selected"],
            "wrong_on_selected": human["wrong_on_selected"],
            "precision": human["right_on_selected"] / judged if judged else None,
            "precision_lower_bound_95": _bound(human["right_on_selected"], judged),
            "misses": human["misses"],
            "recall_proxy": human["right_on_selected"]
            / (human["right_on_selected"] + human["misses"])
            if human["right_on_selected"] + human["misses"]
            else None,
        },
        "agreement": {
            key: sum(side["agreement"][key] for side in by_source.values())
            for key in ("both", "agree", "disagree")
        },
        "by_source": by_source,
        "bars": bars(),
    }

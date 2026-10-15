"""The nine stage metrics, each with one unit, numerator and denominator.

Failed, missing, timed-out and budget-exhausted attempts stay in denominators.
Rows without a label are counted as ``n_unknown`` and excluded from rates.
Abstentions (null values) are reported apart from wrong claims. Unknown judge
verdicts are excluded from rates, counted, and never pass a gate.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from datetime import date, timedelta

from hushh_eval.drive_packets.deterministic import date_source_trap
from hushh_eval.drive_packets.stats import one_per_family, summary

COMPLETED = "completed"
TYPE_FAMILIES = (
    ("statement", ("statement", "activity", "account summary")),
    ("tax", ("1099", "w-2", "w2", "1098", "tax", "k-1", "form 5498", "1040")),
    ("receipt", ("receipt", "invoice", "bill", "order confirmation")),
    ("transfer", ("wire", "transfer", "ach", "remittance")),
    ("equity", ("equity", "rsu", "stock award", "vesting", "espp", "option")),
    ("gains", ("realized", "gain", "loss", "cost basis")),
    ("positions", ("position", "holding", "portfolio")),
    ("legal", ("trust", "will", "estate", "agreement", "contract", "deed", "power of attorney")),
    ("identity", ("passport", "license", "identity", "id card")),
    ("insurance", ("insurance", "policy", "claim")),
    ("medical", ("medical", "lab", "prescription", "health")),
)


def score(metric: str, successes: int, trials: int, *, unit: str, independence: str, **extra):
    return {
        "metric": metric,
        **summary(successes, trials),
        "unit": unit,
        "independence": independence,
        "n_unknown": extra.pop("n_unknown", 0),
        "extra": extra,
    }


def norm_text(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()


def last4(value: object) -> str | None:
    digits = re.findall(r"\d", str(value or ""))
    return "".join(digits[-4:]) if len(digits) >= 4 else None


def type_family(value: object) -> str | None:
    text = str(value or "").casefold()
    if not text.strip():
        return None
    for family, words in TYPE_FAMILIES:
        if any(word in text for word in words):
            return family
    return "other"


def same_value(field: str, gold: object, predicted: object) -> bool:
    if field == "account":
        return last4(gold) is not None and last4(gold) == last4(predicted)
    if field == "document_type":
        return type_family(gold) == type_family(predicted)
    if field == "record_status":
        return norm_text(gold) == norm_text(predicted)
    gold_tokens, predicted_tokens = set(norm_text(gold).split()), set(norm_text(predicted).split())
    if not gold_tokens or not predicted_tokens:
        return False
    return gold_tokens <= predicted_tokens or predicted_tokens <= gold_tokens


# 1. Discovery coverage -------------------------------------------------------
def discovery_coverage(listing: set[str], system: set[str], indexed: set[str]) -> list[dict]:
    return [
        score(
            "discovery_coverage",
            len(listing & system),
            len(listing),
            unit="file_in_independent_listing",
            independence="census",
        ),
        score(
            "indexed_coverage",
            len(listing & indexed),
            len(listing),
            unit="file_in_independent_listing",
            independence="census",
        ),
        score(
            "phantom_rate",
            len(system - listing),
            len(system),
            unit="system_document_row",
            independence="census",
        ),
    ]


def unsupported_correct(rows: list[dict]) -> dict:
    labeled = [row for row in rows if row.get("gold_unsupported") is not None]
    correct = sum(row["gold_unsupported"] is True for row in labeled)
    return score(
        "unsupported_label_correct",
        correct,
        len(labeled),
        unit="unsupported_sample_file",
        independence="file",
        n_unknown=len(rows) - len(labeled),
    )


# 2. Extraction ---------------------------------------------------------------
def extraction(rows: list[dict]) -> list[dict]:
    labeled = [row for row in rows if row.get("true_pages") is not None]
    passed = false_complete = with_gaps = 0
    for row in labeled:
        done = row.get("status") == COMPLETED
        pages_ok = done and row.get("extracted_pages") == row["true_pages"]
        recall_ok = row.get("key_total", 0) == 0 or row.get("key_found", 0) == row["key_total"]
        claimed = row.get("claimed_complete") is True
        is_false_complete = claimed and (not pages_ok or not recall_ok)
        false_complete += is_false_complete
        with_gaps += done and not claimed
        passed += done and pages_ok and recall_ok and not is_false_complete
    unknown = len(rows) - len(labeled)
    return [
        score(
            "extraction_accuracy",
            passed,
            len(labeled),
            unit="document",
            independence="document_clustered_by_family",
            n_unknown=unknown,
        ),
        score(
            "extraction_false_complete",
            false_complete,
            len(labeled),
            unit="document",
            independence="document_clustered_by_family",
            n_unknown=unknown,
        ),
        # Honestly flagged gaps pass the accuracy definition but are not fully read.
        score(
            "extraction_with_gaps",
            with_gaps,
            len(labeled),
            unit="document",
            independence="document_clustered_by_family",
            n_unknown=unknown,
        ),
    ]


# 3. Facts --------------------------------------------------------------------
def facts(rows: list[dict]) -> list[dict]:
    labeled = [row for row in rows if row.get("gold") not in (None, "")]
    correct = wrong = abstained = failed = 0
    for row in labeled:
        predicted = row.get("predicted")
        if row.get("status") != COMPLETED:
            failed += 1
        elif predicted in (None, ""):
            abstained += 1
        elif same_value(row["field"], row["gold"], predicted):
            correct += 1
        else:
            wrong += 1
    unknown = len(rows) - len(labeled)
    return [
        score(
            "fact_accuracy",
            correct,
            len(labeled),
            unit="labeled_field",
            independence="field_clustered_by_document",
            n_unknown=unknown,
            abstained=abstained,
            failed_attempts=failed,
            wrong=wrong,
        ),
        score(
            "wrong_claim_rate",
            wrong,
            correct + wrong,
            unit="non_null_field",
            independence="field_clustered_by_document",
            n_unknown=unknown,
        ),
    ]


def citation_validity(citations: list[dict], pages: dict) -> dict:
    valid = sum(
        citation.get("quote", "") in (pages.get(citation.get("page")) or "")
        for citation in citations
    )
    return score(
        "citation_validity", valid, len(citations), unit="citation", independence="citation"
    )


# 4. Content periods ----------------------------------------------------------
def _days(intervals: list[tuple[str, str]]) -> set[date]:
    days: set[date] = set()
    for start, end in intervals:
        first, last = date.fromisoformat(start), date.fromisoformat(end)
        if last < first or (last - first).days > 3660:
            continue
        days.update(first + timedelta(days=offset) for offset in range((last - first).days + 1))
    return days


def interval_iou(gold: list[tuple[str, str]], predicted: list[tuple[str, str]]) -> float:
    a, b = _days(gold), _days(predicted)
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b) if a | b else 0.0


def periods(rows: list[dict]) -> list[dict]:
    labeled = [row for row in rows if row.get("gold") is not None]
    exact = traps = 0
    ious = []
    for row in labeled:
        gold = sorted(tuple(item) for item in row["gold"])
        predicted = (
            sorted(tuple(item) for item in row.get("predicted") or [])
            if row.get("status") == COMPLETED
            else None
        )
        if predicted is None:
            ious.append(0.0)
            continue
        exact += predicted == gold
        ious.append(interval_iou(gold, predicted))
        gold_months = {(s[:7], e[:7]) for s, e in gold}
        traps += any(
            date_source_trap({"start": s, "end": e, "citations": []}, row.get("metadata") or {})
            and (s[:7], e[:7]) not in gold_months
            for s, e in predicted
        )
    unknown = len(rows) - len(labeled)
    return [
        score(
            "period_exact_match",
            exact,
            len(labeled),
            unit="labeled_document",
            independence="document_clustered_by_family",
            n_unknown=unknown,
            mean_iou=(math.fsum(ious) / len(ious)) if ious else None,
        ),
        score(
            "date_source_trap",
            traps,
            len(labeled),
            unit="labeled_document",
            independence="document_clustered_by_family",
            n_unknown=unknown,
        ),
    ]


# 5. Retrieval ----------------------------------------------------------------
def recall_at_k(ranked: list[str], relevant: set[str], k: int) -> float | None:
    if not relevant:
        return None
    return len(set(ranked[:k]) & relevant) / len(relevant)


def reciprocal_rank(ranked: list[str], relevant: set[str]) -> float:
    for index, item in enumerate(ranked, start=1):
        if item in relevant:
            return 1 / index
    return 0.0


def ndcg_at_k(ranked: list[str], relevant: set[str], k: int = 8) -> float | None:
    if not relevant:
        return None
    gain = sum(
        1 / math.log2(i + 1) for i, item in enumerate(ranked[:k], start=1) if item in relevant
    )
    ideal = sum(1 / math.log2(i + 1) for i in range(1, min(k, len(relevant)) + 1))
    return gain / ideal


def retrieval(requests: list[dict], *, retrievable_fraction: float | None) -> list[dict]:
    positives = [row for row in requests if row.get("relevant")]
    negatives = [row for row in requests if not row.get("relevant")]
    results = []
    for k in (1, 3, 5, 8):
        found = sum(
            1
            for row in positives
            if row.get("status") == COMPLETED
            and (recall_at_k(row.get("ranked", []), set(row["relevant"]), k) or 0) == 1
        )
        results.append(
            score(
                f"retrieval_all_relevant_at_{k}",
                found,
                len(positives),
                unit="buyer_request",
                independence="request",
                retrievable_fraction=retrievable_fraction,
            )
        )
    rr = [
        reciprocal_rank(row.get("ranked", []), set(row["relevant"]))
        if row.get("status") == COMPLETED
        else 0.0
        for row in positives
    ]
    gains = [
        ndcg_at_k(row.get("ranked", []), set(row["relevant"])) or 0.0
        if row.get("status") == COMPLETED
        else 0.0
        for row in positives
    ]
    no_match = sum(
        row.get("status") == COMPLETED and row.get("decision") == "no_match" for row in negatives
    )
    results.append(
        score(
            "no_match_correct",
            no_match,
            len(negatives),
            unit="negative_request",
            independence="request",
            mrr=(math.fsum(rr) / len(rr)) if rr else None,
            ndcg_at_8=(math.fsum(gains) / len(gains)) if gains else None,
        )
    )
    return results


# 6. Packets ------------------------------------------------------------------
def jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a | b else 0.0


def match_groups(packets: list[dict], groups: dict[str, set[str]]) -> dict[str, str | None]:
    matches = {}
    for packet in packets:
        selected = set(packet.get("selected", []))
        best = max(groups, key=lambda key: (jaccard(selected, groups[key]), key), default=None)
        matches[packet["packet_key"]] = (
            best if best is not None and jaccard(selected, groups[best]) >= 0.5 else None
        )
    return matches


def packet_quality(packets: list[dict], groups: dict[str, set[str]]) -> list[dict]:
    matches = match_groups(packets, groups)
    correct = completeness_num = completeness_den = 0
    unknown = 0
    for packet in packets:
        group = matches[packet["packet_key"]]
        verdict = packet.get("verdict")
        if verdict == "unknown" or verdict is None:
            unknown += 1
            continue
        selected = set(packet.get("selected", []))
        if group is not None:
            completeness_num += len(selected & groups[group])
            completeness_den += len(groups[group])
        correct += (
            verdict == "pass"
            and group is not None
            and selected <= groups[group]
            and not packet.get("deterministic_failures")
        )
    multi = {key for key, members in groups.items() if len(members) >= 2}
    covered = {group for group in matches.values() if group in multi}
    return [
        score(
            "packet_correctness",
            correct,
            len(packets) - unknown,
            unit="packet_version",
            independence="packet_version",
            n_unknown=unknown,
        ),
        score(
            "packet_completeness",
            completeness_num,
            completeness_den,
            unit="labeled_member_in_scope",
            independence="member_clustered_by_packet",
        ),
        score(
            "group_coverage",
            len(covered),
            len(multi),
            unit="labeled_group_with_2_or_more",
            independence="group",
        ),
    ]


# 7. False Ready --------------------------------------------------------------
def false_ready(packets: list[dict], *, seed: int = 20261015) -> list[dict]:
    ready = [packet for packet in packets if packet.get("state") == "ready"]
    consensus = [packet for packet in ready if packet.get("verdict") in {"pass", "fail"}]
    wrong = [packet for packet in consensus if packet["verdict"] == "fail"]
    severity = Counter(packet.get("severity") or "none" for packet in wrong)
    # A family is the independent unit and counts as wrong if any of its judged
    # Ready packets is wrong: a correct sibling never hides a wrong one. Among
    # correct ones, a packet a person confirmed represents the family.
    gated = one_per_family(
        consensus,
        seed=seed,
        rank=lambda packet: 0 if packet["verdict"] == "fail" else 1 if packet.get("human") else 2,
    )
    return [
        score(
            "false_ready_rate",
            len(wrong),
            len(consensus),
            unit="ready_packet_version_with_consensus",
            independence="packet_version",
            n_unknown=len(ready) - len(consensus),
            severity=dict(severity),
        ),
        score(
            "ready_correct_one_per_family",
            sum(packet["verdict"] == "pass" for packet in gated),
            len(gated),
            unit="independent_family",
            independence="one_ready_packet_per_family",
            n_unknown=len(ready) - len(consensus),
            open_s1=sum(packet.get("severity") == "S1" for packet in wrong),
            human_confirmed=sum(bool(packet.get("human")) for packet in gated),
        ),
    ]


# 8. Price sanity -------------------------------------------------------------
def price_sanity(packets: list[dict], *, pairs: list[tuple[int, int]], injected: list[tuple]):
    priced = [packet for packet in packets if packet.get("price_cents") is not None]
    sane = sum(not packet.get("price_findings") for packet in priced)
    monotonic = sum(1 for low, high in pairs if low <= high)
    unmoved = sum(1 for base, attacked in injected if attacked <= base * 1.10 + 50)
    return [
        score(
            "price_sane",
            sane,
            len(priced),
            unit="priced_packet",
            independence="packet_version",
            n_unknown=len(packets) - len(priced),
        ),
        score(
            "price_monotonic_pairs",
            monotonic,
            len(pairs),
            unit="declared_pair",
            independence="pair",
        ),
        score(
            "price_injection_unmoved",
            unmoved,
            len(injected),
            unit="injected_pair",
            independence="pair",
        ),
    ]


# 9. Delivery -----------------------------------------------------------------
def delivery(receipts: list[dict]) -> list[dict]:
    observed = [row for row in receipts if row.get("observed") and not row.get("simulated")]
    correct = sum(
        set(row.get("delivered_ids", []))
        == set(row.get("approved_ids", []))
        == set(row.get("paid_ids", []))
        and len(row.get("delivered_ids", [])) == len(set(row.get("delivered_ids", [])))
        for row in observed
    )
    unauthorized = sum(
        len(set(row.get("delivered_ids", [])) - set(row.get("approved_ids", [])))
        for row in observed
    )
    return [
        score(
            "delivery_correct",
            correct,
            len(observed),
            unit="observed_receipt",
            independence="receipt",
            n_unknown=len(receipts) - len(observed),
            unauthorized_deliveries=unauthorized,
        )
    ]

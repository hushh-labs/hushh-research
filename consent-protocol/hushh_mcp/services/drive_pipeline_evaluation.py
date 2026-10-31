"""Offline, label-based measurements; never an approval or model confidence score.

Labels remain outside adapter inputs. Missing/error attempts stay in denominators.
Exact bounds describe binomial units; correlated document/variant counts do not
establish independent production reliability. No credentials or provider effects.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from pathlib import Path

SCHEMA_VERSION = "drive-pipeline-eval-v1"
TARGET = 0.999
ALPHA = 0.05


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def zero_failure_sample_size(target: float = TARGET, alpha: float = ALPHA) -> int:
    if not 0 < target < 1 or not 0 < alpha < 1:
        raise ValueError("invalid_probability")
    return math.ceil(math.log(alpha) / math.log(target))


def _log_cdf(k: int, n: int, p: float) -> float:
    term = n * math.log1p(-p)
    terms = [term]
    for i in range(k):
        term += math.log(n - i) - math.log(i + 1) + math.log(p) - math.log1p(-p)
        terms.append(term)
    largest = max(terms)
    return largest + math.log(math.fsum(math.exp(x - largest) for x in terms))


def exact_lower_bound(successes: int, trials: int, alpha: float = ALPHA) -> float | None:
    """One-sided Clopper-Pearson lower bound, by binomial-tail inversion.

    https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm
    No normal approximation when failures are rare. Alpha is tail probability.
    """
    if type(successes) is not int or type(trials) is not int:
        raise ValueError("counts_must_be_integers")
    if not 0 <= successes <= trials or not 0 < alpha < 1:
        raise ValueError("invalid_binomial_counts")
    if trials == 0:
        return None
    if successes == 0:
        return 0.0
    if successes == trials:
        return alpha ** (1 / trials)
    low, high = 0.0, 1.0
    for _ in range(65):
        p = (low + high) / 2
        if successes > trials // 2:
            tail = math.exp(_log_cdf(trials - successes, trials, 1 - p))
        else:
            tail = -math.expm1(min(0.0, _log_cdf(successes - 1, trials, p)))
        if tail < alpha:
            low = p
        else:
            high = p
    return low


def metric(successes: int, trials: int, unit: str) -> dict:
    return {
        "successes": successes,
        "trials": trials,
        "rate": successes / trials if trials else None,
        "lower_95_one_sided": exact_lower_bound(successes, trials),
        "unit": unit,
        "bound_assumption": "independent_representative_binomial_units",
    }


def load_dataset(path: Path) -> dict:
    """Validate immutable original bytes and keep labels in the host only."""
    raw = path.read_bytes()
    dataset = json.loads(raw)
    if dataset.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("unsupported_dataset_version")
    if not dataset.get("version") or not dataset.get("reference", {}).get("source"):
        raise ValueError("reference_provenance_required")
    ids, families, artifact_partitions = set(), {}, {}
    for case in dataset["cases"]:
        if case["id"] in ids or case["partition"] not in {"dev", "heldout"}:
            raise ValueError("invalid_case_identity")
        ids.add(case["id"])
        family = case["correlation_group"]
        if not family or families.setdefault(family, case["partition"]) != case["partition"]:
            raise ValueError("family_leaks_across_partitions")
        refs = set()
        for document in case["documents"]:
            ref = document["ref"]
            if ref in refs or document["relevance"] not in {"include", "exclude", "unknown"}:
                raise ValueError("invalid_document_reference")
            refs.add(ref)
            source = (path.parent / document["path"]).resolve()
            if not source.is_relative_to(path.parent.resolve()):
                raise ValueError("artifact_outside_dataset")
            if sha256(source.read_bytes()) != document["sha256"]:
                raise ValueError("artifact_hash_mismatch")
            if (
                artifact_partitions.setdefault(document["sha256"], case["partition"])
                != case["partition"]
            ):
                raise ValueError("artifact_leaks_across_partitions")
        if not set(case["expected_packet"]["selected_refs"]) <= refs:
            raise ValueError("unknown_gold_selection")
        price = case.get("pricing_reference")
        if price and (
            not price.get("criteria_version")
            or not price.get("source")
            or not 50 <= price["min_cents"] <= price["max_cents"] <= 50_000
        ):
            raise ValueError("invalid_pricing_reference")
    return {**dataset, "dataset_sha256": sha256(raw)}


def adapter_input(case: dict, root: Path) -> dict:
    """Allowlist, never forward a gold label, pricing range or expected packet."""
    documents = []
    for item in case["documents"]:
        content = (root / item["path"]).read_bytes()
        if sha256(content) != item["sha256"]:
            raise ValueError("artifact_hash_mismatch")
        documents.append(
            {key: item[key] for key in ("ref", "mime_type", "source_version", "sha256")}
            | {"content": content}
            | (
                {
                    "source_metadata": {
                        key: item["source_metadata"][key]
                        for key in ("name", "modifiedTime", "createdTime")
                        if key in item["source_metadata"]
                    }
                }
                if item.get("source_metadata")
                else {}
            )
        )
    return {
        "case_id": case["id"],
        "request": case["request"],
        "documents": documents,
    }


def _refs(row: dict, key: str) -> set:
    value = row.get(key, [])
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError("invalid_observed_refs")
    if len(set(value)) != len(value):
        raise ValueError("duplicate_observed_refs")
    return set(value)


def grade_attempt(case: dict, row: dict) -> dict:
    gold = case["expected_packet"]
    wanted = set(gold["selected_refs"])
    selected = _refs(row, "selected_refs")
    discovered = _refs(row, "discovered_refs")
    refs = {document["ref"] for document in case["documents"]}
    completed = row.get("status") == "completed"
    coverage = row.get("coverage") == gold["coverage"]
    exact_packet = (
        completed and selected == wanted and row.get("packet_status") == gold["status"] and coverage
    )
    decisions = row.get("document_decisions", {})
    correct = sum(
        decisions.get(document["ref"]) == document["relevance"] for document in case["documents"]
    )
    extraction = row.get("extraction", {})
    facts = row.get("document_facts", {})
    fact_total = fact_correct = 0
    for document in case["documents"]:
        for name, expected in document.get("facts", {}).items():
            fact_total += 1
            fact_correct += facts.get(document["ref"], {}).get(name) == expected
    if row.get("packet_status") == "ready":
        # A lucky selection cannot conceal a known unreadable original or wrong
        # content facts. This is packet evidence correctness, not string matching.
        exact_packet = exact_packet and all(
            extraction.get(ref, {}).get("complete") is True
            and extraction.get(ref, {}).get("has_gaps") is False
            for ref in refs
        )
        exact_packet = exact_packet and all(
            facts.get(document["ref"], {}).get(name) == expected
            for document in case["documents"]
            if document["ref"] in selected
            for name, expected in document.get("facts", {}).items()
        )
    delivery = row.get("delivery", {})
    delivered = set(delivery.get("delivered_refs", []))
    delivery_observed = delivery.get("observed") is True and bool(delivery.get("evidence_source"))
    approved = set(delivery.get("approved_refs", []))
    price = row.get("suggested_price_cents")
    price_ref = case.get("pricing_reference")
    valid_price = type(price) is int and 50 <= price <= 50_000
    return {
        "case_id": case["id"],
        "partition": case["partition"],
        "correlation_group": case["correlation_group"],
        "completed": completed,
        "true_positives": len(selected & wanted),
        "false_positives": len(selected - wanted),
        "false_negatives": len(wanted - selected),
        "gold_relevant": len(wanted),
        "discovery_true_positives": len(discovered & wanted),
        "unknown_selected": len(selected - refs),
        "document_correct": correct,
        "document_total": len(refs),
        "fact_correct": fact_correct,
        "fact_total": fact_total,
        "extraction_complete": sum(
            extraction.get(ref, {}).get("complete") is True
            and extraction.get(ref, {}).get("has_gaps") is False
            for ref in refs
        ),
        "packet_correct": exact_packet,
        "ready": row.get("packet_status") == "ready",
        "coverage_correct": completed and coverage,
        "evaluator_observed": type(row.get("evaluator_accept")) is bool,
        # The verifier accepts a packet for delivery. Correctly refusing an
        # unverifiable packet agrees with the reference, even when the pipeline
        # itself correctly reported that abstention.
        "evaluator_agrees": row.get("evaluator_accept")
        == (exact_packet and gold["status"] == "ready"),
        "delivery_observed": delivery_observed,
        "delivery_correct": delivery_observed and delivered == wanted == approved,
        "unauthorized_deliveries": len(delivered - approved) if delivery_observed else 0,
        "price_valid": valid_price,
        "price_reference_present": bool(price_ref),
        "price_within_reference": bool(
            valid_price and price_ref and price_ref["min_cents"] <= price <= price_ref["max_cents"]
        ),
    }


def _percentile(values: list[float], fraction: float) -> float | None:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)] if ordered else None


def pricing_monotonicity(cases: list[dict], observed: dict) -> dict:
    """Only independently declared comparable pairs; no universal price ordering."""
    pairs = successes = 0
    for first in cases:
        a = first.get("pricing_reference", {})
        if not a.get("monotonic_group"):
            continue
        for second in cases:
            b = second.get("pricing_reference", {})
            if a["monotonic_group"] != b.get("monotonic_group"):
                continue
            if a["scope_rank"] >= b["scope_rank"]:
                continue
            pairs += 1
            low = observed.get(first["id"], {}).get("suggested_price_cents")
            high = observed.get(second["id"], {}).get("suggested_price_cents")
            successes += type(low) is int and type(high) is int and 50 <= low <= high <= 50_000
    return metric(successes, pairs, "declared_comparable_price_pair")


def _known_total(values: list) -> float | None:
    if not values or any(
        type(value) not in (int, float) or not math.isfinite(value) or value < 0 for value in values
    ):
        return None
    return sum(values)


def _aggregate(grades: list[dict]) -> dict:
    counts = Counter()
    for row in grades:
        for key, value in row.items():
            if isinstance(value, (int, bool)):
                counts[key] += value
    tp, fp, fn = (counts[key] for key in ("true_positives", "false_positives", "false_negatives"))
    ready = [row for row in grades if row["ready"]]
    return {
        "attempts": len(grades),
        "completed": counts["completed"],
        "failed_or_missing": len(grades) - counts["completed"],
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "selection_precision": metric(tp, tp + fp, "observed_selected_document"),
        "recall_all_attempts": metric(tp, tp + fn, "gold_relevant_document"),
        "discovery_recall": metric(
            counts["discovery_true_positives"], tp + fn, "gold_relevant_document"
        ),
        "document_accuracy": metric(
            counts["document_correct"], counts["document_total"], "document"
        ),
        "content_fact_accuracy": metric(
            counts["fact_correct"], counts["fact_total"], "reference_fact"
        ),
        "extraction_completeness": metric(
            counts["extraction_complete"], counts["document_total"], "document"
        ),
        "packet_correctness_all_attempts": metric(
            counts["packet_correct"], len(grades), "packet_attempt"
        ),
        "ready_packet_correctness": metric(
            sum(row["packet_correct"] for row in ready), len(ready), "ready_packet"
        ),
        "ready_rate": metric(len(ready), len(grades), "packet_attempt"),
        "false_ready_packets": sum(not row["packet_correct"] for row in ready),
        "coverage_accuracy": metric(counts["coverage_correct"], len(grades), "packet_attempt"),
        "evaluator_agreement": metric(
            counts["evaluator_agrees"], counts["evaluator_observed"], "observed_evaluator_decision"
        ),
        "delivery_correctness": metric(
            counts["delivery_correct"], counts["delivery_observed"], "observed_delivery"
        ),
        "unauthorized_deliveries": counts["unauthorized_deliveries"],
        "price_within_reference": metric(
            counts["price_within_reference"],
            counts["price_reference_present"],
            "priced_reference_case",
        ),
        "price_validity": metric(counts["price_valid"], len(grades), "packet_attempt"),
    }


def build_report(dataset: dict, attempts: list[dict], *, runtime: dict) -> dict:
    """Missing cases are failed attempts. Extra/duplicate case rows are rejected.

    Repetitions belong in separate runs; they never enlarge independent n.
    Runtime hashes are supplied by the actual adapter, not inferred from aliases.
    """
    observed = {row["case_id"]: row for row in attempts}
    cases = {case["id"]: case for case in dataset["cases"]}
    if len(observed) != len(attempts) or not set(observed) <= set(cases):
        raise ValueError("invalid_attempt_identity")
    rows = [observed.get(key, {"case_id": key, "status": "missing"}) for key in cases]
    grades = [grade_attempt(cases[row["case_id"]], row) for row in rows]
    heldout = [row for row in grades if row["partition"] == "heldout"]
    holdout_metrics = _aggregate(heldout)
    sampling = dataset.get("sampling", {})
    provenance = dataset["reference"]
    independent = len({row["correlation_group"] for row in heldout}) == len(heldout)
    holdout_artifacts = [
        document["sha256"]
        for case in cases.values()
        if case["partition"] == "heldout"
        for document in case["documents"]
    ]
    independent = independent and len(set(holdout_artifacts)) == len(holdout_artifacts)
    runtime_keys = (
        "code_sha",
        "manifest_sha256",
        "schema_sha256",
        "provider_model_version",
        "extraction_version",
    )
    eligible = (
        bool(heldout)
        and dataset.get("corpus_kind") == "authorized_real"
        and provenance.get("independent_of_model") is True
        and bool(provenance.get("label_version"))
        and sampling.get("representative_independent_holdout") is True
        and bool(sampling.get("source"))
        and sampling.get("fixed_sample_size") == len(heldout)
        and independent
        and all(runtime.get(key) for key in runtime_keys)
    )
    lower = holdout_metrics["packet_correctness_all_attempts"]["lower_95_one_sided"]
    ready_lower = holdout_metrics["ready_packet_correctness"]["lower_95_one_sided"]
    precision_lower = holdout_metrics["selection_precision"]["lower_95_one_sided"]
    selection_eligible = (
        eligible
        and sampling.get("independent_selected_document_units") is True
        and bool(sampling.get("selected_document_sampling_source"))
    )
    latencies = [
        row["latency_ms"] for row in rows if isinstance(row.get("latency_ms"), (float, int))
    ]
    costs = [row.get("usage", {}).get("cost_usd") for row in rows]
    input_tokens = [row.get("usage", {}).get("input_tokens") for row in rows]
    output_tokens = [row.get("usage", {}).get("output_tokens") for row in rows]
    stage_names = {name for row in rows for name in row.get("stage_latency_ms", {})}
    return {
        "schema_version": SCHEMA_VERSION,
        "dataset_version": dataset["version"],
        "dataset_sha256": dataset["dataset_sha256"],
        "reference": provenance,
        "artifacts": [
            {
                "case_id": case["id"],
                "ref": document["ref"],
                "sha256": document["sha256"],
                "source_version": document["source_version"],
            }
            for case in cases.values()
            for document in case["documents"]
        ],
        "runtime": runtime,
        "all": _aggregate(grades),
        "dev": _aggregate([row for row in grades if row["partition"] == "dev"]),
        "heldout": holdout_metrics,
        "statuses": dict(Counter(row.get("status", "missing") for row in rows)),
        "error_stages": dict(
            Counter(
                row.get("error_stage", "unknown")
                for row in rows
                if row.get("status") != "completed"
            )
        ),
        "abstained_packets": sum(
            row.get("packet_status") in {"unable_to_verify", "insufficient_evidence"}
            for row in rows
        ),
        "correlation": {
            "heldout_attempts": len(heldout),
            "heldout_unique_families": len({row["correlation_group"] for row in heldout}),
            "independent_declared": eligible,
        },
        "latency_ms": {
            "observed": len(latencies),
            "p50": _percentile(latencies, 0.5),
            "p95": _percentile(latencies, 0.95),
            "p99": _percentile(latencies, 0.99),
        },
        "stage_latency_ms": {
            name: {
                "p50": _percentile(
                    [
                        row["stage_latency_ms"][name]
                        for row in rows
                        if name in row.get("stage_latency_ms", {})
                    ],
                    0.5,
                ),
                "p95": _percentile(
                    [
                        row["stage_latency_ms"][name]
                        for row in rows
                        if name in row.get("stage_latency_ms", {})
                    ],
                    0.95,
                ),
            }
            for name in sorted(stage_names)
        },
        "usage": {
            "input_tokens": _known_total(input_tokens),
            "output_tokens": _known_total(output_tokens),
            "cost_usd": _known_total(costs),
            "unknown_cost_attempts": sum(value is None for value in costs),
        },
        "pricing_monotonicity": pricing_monotonicity(list(cases.values()), observed),
        "acceptance": {
            "target": TARGET,
            "metric": "packet_correctness_all_attempts",
            "confidence": 0.95,
            "minimum_zero_failure_independent_packets": zero_failure_sample_size(),
            "sampling_and_provenance_eligible": eligible,
            "supports_target": bool(eligible and lower is not None and lower >= TARGET),
            "ready_packet_supports_target": bool(
                eligible and ready_lower is not None and ready_lower >= TARGET
            ),
            "selection_precision_supports_target": bool(
                selection_eligible and precision_lower is not None and precision_lower >= TARGET
            ),
            "price_accuracy_claim": False,
        },
        "limitations": [
            "Model self-confidence is not a reference label or calibrated probability.",
            "Document, fact and repeated-family bounds are descriptive unless their independence assumptions hold.",
            "Fixed-sample bounds do not authorize optional stopping or repeated peeking for promotion.",
            "Unobserved delivery and provider usage remain unknown; no simulated result proves live delivery.",
            "Pricing ranges are a versioned product rubric, not market value or 99.9% price accuracy.",
        ],
        "grades": grades,
    }

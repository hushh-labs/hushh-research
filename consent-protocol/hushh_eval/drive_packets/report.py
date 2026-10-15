"""Founder report (12 lines or fewer, plain words, every number as 'x of n') and the
engineer report (JSON that passes the public allowlist).

Reports are built from counts and fixed phrases only, so no file name, issuer,
account number or document text can reach them; ``privacy`` checks that again.
"""

from __future__ import annotations

from hushh_eval.drive_packets.privacy import public_payload

COMPARABILITY_KEYS = ("strata_version", "label_version", "judge_signature", "request_set_version")
REASONS = {
    "open_s1": "a serious mistake is still open",
    "ready_packet_wrong": "some Ready packets were wrong",
    "human_confirmation_missing": "a person has not confirmed the checks yet",
    "too_many_unknown_verdicts": "too many checks were inconclusive",
    "stale_label_version": "the labels changed after scoring",
    "cleared": "it met the bar",
}
MAX_FOUNDER_LINES = 12


def _metric(scorecard: dict, name: str) -> dict:
    return next((row for row in scorecard.get("scores", []) if row["metric"] == name), {})


def _xn(row: dict) -> str:
    if not row or not row.get("trials"):
        return "not measured yet"
    return f"{row['successes']:,} of {row['trials']:,}"


def _reason(code: str) -> str:
    if code.startswith("needs_"):
        parts = code.split("_")
        return f"{parts[-1]} independent Ready packets were checked and {parts[1]} are needed"
    return REASONS.get(code, "the evidence is not complete")


def founder_report(scorecard: dict, gate: dict) -> str:
    bars = scorecard["bars"]
    gated = _metric(scorecard, "ready_correct_one_per_family")
    judged = gated.get("trials", 0)
    wrong = judged - gated.get("successes", 0)
    unknown = gated.get("n_unknown", 0)
    mode = scorecard["mode"]
    sha = (scorecard.get("code_sha") or "unknown")[:7]
    where = f"replay of code {sha}" if mode == "replay" else f"served UAT build {sha}"
    facts = _metric(scorecard, "fact_accuracy")
    wrong_claims = _metric(scorecard, "wrong_claim_rate")
    dates = _metric(scorecard, "period_exact_match")
    trap = _metric(scorecard, "date_source_trap")
    search = _metric(scorecard, "retrieval_all_relevant_at_5")
    price = _metric(scorecard, "price_sane")
    delivery = _metric(scorecard, "delivery_correct")
    lines = [
        f"Drive packet check {scorecard['batch_id']}: {where}, {scorecard['files']:,} files.",
        f"Ready packets wrong: {wrong:,} of {judged:,} "
        f"(95% bar needs 0 of {bars['n95']:,}; 99.9% bar needs 0 of {bars['n999']:,}).",
        f"Checked by a person: {scorecard.get('human_confirmed_ready', 0):,} of {judged:,}; "
        "the rest by two AI judges and fixed rules.",
        f"Not decided yet: {unknown:,} Ready packets (counted as not passed).",
        f"Files read with the right page count: {_xn(_metric(scorecard, 'extraction_accuracy'))}; "
        f"with unreadable pages: {_xn(_metric(scorecard, 'extraction_with_gaps'))}"
        + (
            f"; {_metric(scorecard, 'extraction_env_limited')['successes']:,} more need OCR "
            "this check could not run."
            if _metric(scorecard, "extraction_env_limited").get("successes")
            else "."
        ),
        f"Facts that match the labels: {_xn(facts)}; facts that contradict them: "
        + (
            f"{wrong_claims['successes']:,} of {wrong_claims['trials']:,}."
            if wrong_claims.get("trials")
            else "none measured."
        ),
        f"Dates that match the labels: {_xn(dates)}; dates taken from file edit time: "
        + (
            f"{trap['successes']:,} of {trap['trials']:,}."
            if trap.get("trials")
            else "not measured yet."
        ),
        "Labels: "
        + (
            "made by AI and fixed rules; no person has checked them yet."
            if not scorecard.get("human_labels")
            else f"{scorecard['human_labels']:,} checked by a person, the rest by AI and fixed rules."
        ),
        f"Buyer search finds it in the top 5: {_xn(search)}.",
        f"Prices make sense: {_xn(price)}.",
        "Deliveries: "
        + (f"{_xn(delivery)} right." if delivery.get("trials") else "no live sales observed yet."),
        "Safe to list: "
        + (
            "yes."
            if gate["status"] == "pass"
            else "not yet, because " + "; ".join(_reason(code) for code in gate["reasons"]) + "."
        ),
    ]
    if len(lines) > MAX_FOUNDER_LINES:
        raise ValueError("founder_report_too_long")
    return "\n".join(lines) + "\n"


def engineer_report(scorecard: dict, gates: list[dict], extra: dict | None = None) -> dict:
    payload = {
        "batch_id": scorecard["batch_id"].lower(),
        "mode": scorecard["mode"],
        "code_sha": scorecard.get("code_sha"),
        "label_version": scorecard["label_version"],
        "files": scorecard["files"],
        "scores": [
            {
                **{
                    key: row[key]
                    for key in (
                        "metric",
                        "successes",
                        "trials",
                        "rate",
                        "cp_lower_95",
                        "wilson_lower_95",
                        "unit",
                        "independence",
                        "n_unknown",
                    )
                },
                "extra": {
                    key.lower(): (
                        {k.lower(): v for k, v in value.items()}
                        if isinstance(value, dict)
                        else value
                    )
                    for key, value in (row.get("extra") or {}).items()
                },
            }
            for row in scorecard.get("scores", [])
        ],
        "gates": [
            {
                "gate": item["gate"],
                "status": item["status"],
                "reasons": [reason.lower() for reason in item["reasons"]],
            }
            for item in gates
        ],
        **(extra or {}),
    }
    return public_payload(payload)


def comparable(first: dict, second: dict) -> tuple[bool, list[str]]:
    differing = [key for key in COMPARABILITY_KEYS if first.get(key) != second.get(key)]
    return (not differing, differing)


def delta_line(first: dict, second: dict, metric: str) -> str:
    ok, differing = comparable(first, second)
    if not ok:
        return f"{metric}: not comparable ({', '.join(differing)} changed)"
    a, b = _metric(first, metric), _metric(second, metric)
    return f"{metric}: {_xn(a)} before, {_xn(b)} now"

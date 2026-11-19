"""Derive the advisor handshake's schema projection from migration 447."""

import argparse
import json
from pathlib import Path

from generate_location_onboarding_runtime_schema_contracts import table_columns

ROOT = Path(__file__).resolve().parents[1]
TABLES = ("advisor_review_requests", "advisor_review_subscriptions", "advisor_billing_cleanup")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    sql = (ROOT / "db/migrations/447_finance_advisor_handshake.sql").read_text()
    projection = table_columns(sql, table_names=TABLES)
    stale = []
    for name in ("dev_minimum_schema.json", "uat_integrated_schema.json", "prod_core_schema.json"):
        path = ROOT / "db/contracts" / name
        value = json.loads(path.read_text())
        value["required_tables"] = dict(sorted({**value["required_tables"], **projection}.items()))
        for function in (
            "guard_advisor_review",
            "end_advisor_reviews",
            "advisor_subscription_retirement",
        ):
            if function not in value["required_functions"]:
                value["required_functions"].append(function)
        rendered = json.dumps(value, indent=2) + "\n"
        if path.read_text() != rendered:
            stale.append(name)
            if not args.check:
                path.write_text(rendered)
    if args.check and stale:
        raise SystemExit("Stale advisor schema contracts: " + ", ".join(stale))
    print(
        "Advisor schema contracts verified" if args.check else "Advisor schema contracts generated"
    )


if __name__ == "__main__":
    main()

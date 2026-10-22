import pytest


@pytest.mark.parametrize(
    ("ticker", "field", "expected"),
    [
        ("AMZN", "free_cash_flow", 7_695_000_000),
        ("AAPL", "revenue", 416_161_000_000),
    ],
)
def test_recorded_sec_annual_headlines(ticker, field, expected):
    import json
    from datetime import date
    from pathlib import Path

    from hushh_mcp.services.sec_financial_facts import extract_annual_facts

    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "sec" / f"{ticker}.json").read_text()
    )
    extracted = extract_annual_facts(fixture, today=date(2026, 10, 21))
    assert extracted[field] == expected
    assert extracted["period_end"].startswith("2025")
    assert extracted["short_term_borrowings"] is None


def test_recorded_alphabet_trend_uses_periods_instead_of_filing_fiscal_year():
    import json
    from datetime import date
    from pathlib import Path

    from hushh_mcp.services.sec_financial_facts import extract_annual_facts

    fixture = json.loads((Path(__file__).parent / "fixtures" / "sec" / "GOOGL.json").read_text())
    trend = extract_annual_facts(fixture, today=date(2026, 10, 21))["revenue_trend"]
    assert [row["year"] for row in trend] == [2022, 2023, 2024, 2025]
    assert [row["value"] for row in trend] == [
        282836000000,
        307394000000,
        350018000000,
        402836000000,
    ]


def test_sec_latest_period_beats_tag_priority_and_rejects_quarterly_flow():
    from datetime import date

    from hushh_mcp.services.sec_financial_facts import extract_annual_facts

    annual = {
        "form": "10-K",
        "fp": "FY",
        "start": "2025-01-01",
        "end": "2025-12-31",
        "filed": "2026-02-01",
        "val": 200,
    }
    older = {**annual, "start": "2024-01-01", "end": "2024-12-31", "val": 100}
    quarter = {**annual, "start": "2025-10-01", "val": 900}
    payload = {
        "facts": {
            "us-gaap": {
                "RevenueFromContractWithCustomerExcludingAssessedTax": {
                    "units": {"USD": [older, quarter]}
                },
                "Revenues": {"units": {"USD": [annual]}},
            }
        }
    }
    result = extract_annual_facts(payload, today=date(2026, 10, 21))
    assert result["revenue"] == 200
    assert result["free_cash_flow"] is None
    assert extract_annual_facts(payload, today=date(2028, 1, 1))["revenue"] is None

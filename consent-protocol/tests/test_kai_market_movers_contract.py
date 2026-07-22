from api.routes.kai.market_insights import _normalize_mover_row


def test_mover_change_pct_is_percentage_only() -> None:
    normalized = _normalize_mover_row(
        {
            "symbol": "AAPL",
            "price": 210.0,
            "changes": 4.25,
        },
        "test",
    )

    assert normalized is not None
    assert normalized["change_pct"] is None


def test_mover_preserves_a_finite_provider_percentage() -> None:
    normalized = _normalize_mover_row(
        {
            "symbol": "AAPL",
            "changesPercentage": 0.14,
            "changes": 4.25,
        },
        "test",
    )

    assert normalized is not None
    assert normalized["change_pct"] == 0.14


def test_mover_accepts_percent_suffixed_provider_values_and_rejects_non_finite() -> None:
    suffixed = _normalize_mover_row(
        {"symbol": "AAPL", "changesPercentage": "1.25%"},
        "test",
    )
    non_finite = _normalize_mover_row(
        {"symbol": "AAPL", "changesPercentage": "Infinity"},
        "test",
    )

    assert suffixed is not None
    assert suffixed["change_pct"] == 1.25
    assert non_finite is not None
    assert non_finite["change_pct"] is None

def test_disallowed_scope_rejected():
    payload = {
        "allowed_scopes": [
            "profile_read",
        ]
    }

    expected_scope = (
        "financial_data"
    )

    allowed_scopes = payload.get(
        "allowed_scopes",
        [],
    )

    valid = (
        expected_scope
        in allowed_scopes
    )

    assert valid is False

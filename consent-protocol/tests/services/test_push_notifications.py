from hushh_mcp.services.push_notifications import (
    _GENERIC_CONNECTION_REQUEST_BODY,
    _connection_request_body,
)


def test_connection_request_body_names_the_requester():
    assert _connection_request_body("Ankit") == "Ankit wants to connect with you on hushh."


def test_connection_request_body_trims_whitespace_around_the_name():
    assert (
        _connection_request_body("  Ankit Sharma  ")
        == "Ankit Sharma wants to connect with you on hushh."
    )


def test_connection_request_body_falls_back_when_name_is_missing():
    assert _connection_request_body(None) == _GENERIC_CONNECTION_REQUEST_BODY
    assert _connection_request_body("") == _GENERIC_CONNECTION_REQUEST_BODY
    assert _connection_request_body("   ") == _GENERIC_CONNECTION_REQUEST_BODY


def test_connection_request_body_never_emits_none_or_undefined():
    for value in (None, "", "   ", "Ankit"):
        body = _connection_request_body(value)
        assert "None" not in body
        assert "undefined" not in body

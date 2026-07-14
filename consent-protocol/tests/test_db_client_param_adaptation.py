"""
Tests for _adapt_db_param_value and _adapt_db_params in db.db_client.

TDD: RED → GREEN
  - list[dict] cases are written to fail against the original code (no list
    branch) and pass after the fix is applied.
  - All other cases are regression guards.
"""

from __future__ import annotations

import json

from psycopg2.extras import Json as PsycopgJson

from db.db_client import _adapt_db_param_value, _adapt_db_params

# ---------------------------------------------------------------------------
# top-level dict
# ---------------------------------------------------------------------------


def test_dict_postgres_returns_psycopg_json():
    """A top-level dict on postgres → PsycopgJson wrapping the dict."""
    the_dict = {"key": "value", "num": 42}
    result = _adapt_db_param_value(the_dict, dialect_name="postgresql")
    assert isinstance(result, PsycopgJson)
    assert result.adapted == the_dict


def test_dict_sqlite_returns_json_string():
    """A top-level dict on sqlite → json.dumps string."""
    the_dict = {"key": "value"}
    result = _adapt_db_param_value(the_dict, dialect_name="sqlite")
    assert result == json.dumps(the_dict)


def test_dict_no_dialect_returns_json_string():
    """A top-level dict with no dialect → json.dumps string."""
    the_dict = {"a": 1}
    result = _adapt_db_param_value(the_dict, dialect_name=None)
    assert result == json.dumps(the_dict)


# ---------------------------------------------------------------------------
# list[dict] — these are the NEW cases that expose the bug
# ---------------------------------------------------------------------------


def test_list_of_dicts_postgres_returns_psycopg_json():
    """list[dict] on postgres → PsycopgJson wrapping the whole list."""
    rows = [{"a": 1}, {"b": 2}]
    result = _adapt_db_param_value(rows, dialect_name="postgresql")
    assert isinstance(result, PsycopgJson), (
        "list[dict] must be wrapped as PsycopgJson for postgres; got %r instead" % result
    )
    assert result.adapted == rows


def test_list_of_dicts_non_postgres_returns_json_string():
    """list[dict] on sqlite → json.dumps string."""
    rows = [{"a": 1}, {"b": 2}]
    result = _adapt_db_param_value(rows, dialect_name="sqlite")
    assert result == json.dumps(rows), (
        "list[dict] must be json.dumps'd for non-postgres; got %r instead" % result
    )


def test_list_of_dicts_no_dialect_returns_json_string():
    """list[dict] with no dialect → json.dumps string."""
    rows = [{"x": 10}]
    result = _adapt_db_param_value(rows, dialect_name=None)
    assert result == json.dumps(rows)


def test_list_with_nested_dict_postgres_roundtrips():
    """list containing a nested dict on postgres → PsycopgJson; nested structure survives round-trip."""
    rows = [{"meta": {"x": 1, "y": [2, 3]}}]
    result = _adapt_db_param_value(rows, dialect_name="postgresql")
    assert isinstance(result, PsycopgJson)
    # The nested structure must be intact after json-serialising .adapted
    roundtripped = json.loads(json.dumps(result.adapted))
    assert roundtripped == rows


# ---------------------------------------------------------------------------
# list[str] and list[int] — must stay UNCHANGED (TEXT[] / integer[] params)
# ---------------------------------------------------------------------------


def test_list_of_strings_postgres_unchanged():
    """list[str] must NOT be wrapped — it is a TEXT[] param."""
    lst = ["a", "b", "c"]
    result = _adapt_db_param_value(lst, dialect_name="postgresql")
    assert result == lst


def test_list_of_strings_no_dialect_unchanged():
    lst = ["refresh_token_1", "refresh_token_2"]
    result = _adapt_db_param_value(lst, dialect_name=None)
    assert result == lst


def test_list_of_ints_postgres_unchanged():
    lst = [1, 2, 3]
    result = _adapt_db_param_value(lst, dialect_name="postgresql")
    assert result == lst


# ---------------------------------------------------------------------------
# empty list — must stay UNCHANGED
# ---------------------------------------------------------------------------


def test_empty_list_postgres_unchanged():
    result = _adapt_db_param_value([], dialect_name="postgresql")
    assert result == []


def test_empty_list_no_dialect_unchanged():
    result = _adapt_db_param_value([], dialect_name=None)
    assert result == []


# ---------------------------------------------------------------------------
# scalar values — must stay UNCHANGED
# ---------------------------------------------------------------------------


def test_plain_string_unchanged():
    assert _adapt_db_param_value("hello", dialect_name="postgresql") == "hello"


def test_plain_int_unchanged():
    assert _adapt_db_param_value(42, dialect_name="postgresql") == 42


def test_none_unchanged():
    assert _adapt_db_param_value(None, dialect_name="postgresql") is None


# ---------------------------------------------------------------------------
# _adapt_db_params — mixed-param dict
# ---------------------------------------------------------------------------


def test_adapt_db_params_mixed_wraps_only_json_like():
    """
    Given a params dict with a str, a list[str], and a list[dict],
    _adapt_db_params must wrap ONLY the list[dict] (and any plain dict).
    """
    params = {
        "p_user_id": "user-abc",
        "p_refresh_tokens": ["tok1", "tok2"],
        "p_segment_rows": [{"domain": "identity", "score": 0.9}],
        "p_patch": {"has_email": True},
    }
    result = _adapt_db_params(params, dialect_name="postgresql")

    # plain str — unchanged
    assert result["p_user_id"] == "user-abc"

    # list[str] — unchanged (TEXT[] param)
    assert result["p_refresh_tokens"] == ["tok1", "tok2"]

    # list[dict] — must be PsycopgJson
    assert isinstance(result["p_segment_rows"], PsycopgJson)
    assert result["p_segment_rows"].adapted == params["p_segment_rows"]

    # plain dict — must be PsycopgJson
    assert isinstance(result["p_patch"], PsycopgJson)
    assert result["p_patch"].adapted == {"has_email": True}

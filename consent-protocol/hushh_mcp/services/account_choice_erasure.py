"""Operational owner choices removed by the account-erasure transaction."""

from sqlalchemy import text

CHOICE_ERASURE_QUERIES = {
    "one_area_discovery_preferences": text(
        "DELETE FROM one_area_discovery_preferences WHERE user_id = :user_id"
    ),
    "one_area_discovery_search_budgets": text(
        "DELETE FROM one_area_discovery_search_budgets WHERE user_id = :user_id"
    ),
    "one_marketing_preferences": text(
        "DELETE FROM one_marketing_preferences WHERE user_id = :user_id"
    ),
}
CHOICE_ERASURE_TABLES = tuple(CHOICE_ERASURE_QUERIES)

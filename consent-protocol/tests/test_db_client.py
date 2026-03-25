from sqlalchemy import create_engine

from db.db_client import DatabaseClient


def test_execute_raw_commits_insert_returning(tmp_path):
    db_path = tmp_path / "db.sqlite3"
    engine = create_engine(f"sqlite:///{db_path}")
    client = DatabaseClient(engine=engine)

    client.execute_raw(
        """
        CREATE TABLE developer_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_prefix TEXT NOT NULL,
            token_hash TEXT NOT NULL
        )
        """
    )

    inserted = client.execute_raw(
        """
        INSERT INTO developer_tokens (token_prefix, token_hash)
        VALUES (:token_prefix, :token_hash)
        RETURNING id, token_prefix, token_hash
        """,
        {"token_prefix": "hdk_test", "token_hash": "hash"},
    )

    assert inserted.data == [{"id": 1, "token_prefix": "hdk_test", "token_hash": "hash"}]

    selected = client.execute_raw(
        "SELECT id, token_prefix, token_hash FROM developer_tokens WHERE token_prefix = :token_prefix",
        {"token_prefix": "hdk_test"},
    )

    assert selected.data == [{"id": 1, "token_prefix": "hdk_test", "token_hash": "hash"}]

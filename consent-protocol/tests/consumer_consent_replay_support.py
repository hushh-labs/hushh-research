"""Pinned peer-schema fixtures; never install the consumer feature in main."""

import hashlib
from pathlib import Path

# Explicit (migration filename, source checksum) pairs are public provenance,
# not a token-name/credential mapping.
_PEER_FILES = (
    (
        "938_consumer_mcp_connections.sql",
        "fb67fdff7b37d5a84c3df7dcef66d82751a8baa99259339637ac316e393cefd5",
    ),
    (
        "939_consumer_mcp_runtime_tokens.sql",
        "827e8f642dbf225337d19013b4c767f1882361c4ea7d24f5c020e8879be09f59",
    ),
)


def install_consumer_predecessor(execute):
    root = Path(__file__).parent / "fixtures/consumer_consent"
    for name, digest in _PEER_FILES:
        source = (root / name).read_text()
        assert hashlib.sha256(source.encode()).hexdigest() == digest
        execute(source)


def seed_consumer_connections(execute):
    execute("""INSERT INTO developer_apps
      (app_id,agent_id,display_name,contact_email,created_at,updated_at)
      VALUES('synthetic-consumer-app','synthetic-consumer-agent','Synthetic','fixture@example.invalid',0,0);
      INSERT INTO developer_oauth_clients
        (app_id,client_id,client_secret_hash,client_secret_prefix,created_at,secret_rotated_at)
      VALUES('synthetic-consumer-app','synthetic-consumer-client','synthetic-hash','synthetic',0,0);
      INSERT INTO consumer_mcp_connections
        (connection_id,user_id,app_id,client_id,environment,resource,deployment_id,created_at)
      VALUES('cmc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','synthetic-consumer-owner',
         'synthetic-consumer-app','synthetic-consumer-client','dev','https://fixture.invalid','synthetic',0),
        ('cmc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','synthetic-consumer-neighbor',
         'synthetic-consumer-app','synthetic-consumer-client','dev','https://fixture.invalid','synthetic',0);""")

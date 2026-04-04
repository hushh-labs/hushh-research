import pytest

from hushh_mcp.services.vault_keys_service import VaultKeysService


class _FakeSQLResult:
    def __init__(self, rows=None, rowcount=0):
        self._rows = rows or []
        self.rowcount = rowcount

    def fetchone(self):
        if not self._rows:
            return None
        return self._rows[0]


class _FakeSQLConnection:
    def __init__(self, supabase):
        self._supabase = supabase

    def execute(self, statement, params):
        sql = " ".join(str(statement).strip().split()).lower()
        db = self._supabase.db

        if "insert into vault_keys" in sql:
            incoming = dict(params)
            existing_index = next(
                (
                    idx
                    for idx, row in enumerate(db["vault_keys"])
                    if row.get("user_id") == incoming.get("user_id")
                ),
                None,
            )
            if existing_index is None:
                db["vault_keys"].append(incoming)
            else:
                current = db["vault_keys"][existing_index]
                current.update(
                    {
                        "vault_key_hash": incoming["vault_key_hash"],
                        "primary_method": incoming["primary_method"],
                        "primary_wrapper_id": incoming["primary_wrapper_id"],
                        "recovery_encrypted_vault_key": incoming["recovery_encrypted_vault_key"],
                        "recovery_salt": incoming["recovery_salt"],
                        "recovery_iv": incoming["recovery_iv"],
                        "updated_at": incoming["updated_at"],
                    }
                )
            return _FakeSQLResult(rows=[{"user_id": incoming["user_id"]}], rowcount=1)

        if "delete from vault_key_wrappers" in sql:
            user_id = params["user_id"]
            existing = db["vault_key_wrappers"]
            db["vault_key_wrappers"] = [row for row in existing if row.get("user_id") != user_id]
            deleted = len(existing) - len(db["vault_key_wrappers"])
            return _FakeSQLResult(rowcount=deleted)

        if "insert into vault_key_wrappers" in sql:
            incoming = dict(params)
            if incoming["method"] in self._supabase.fail_wrapper_methods:
                raise RuntimeError(f"forced wrapper insert failure: {incoming['method']}")

            existing_index = next(
                (
                    idx
                    for idx, row in enumerate(db["vault_key_wrappers"])
                    if row.get("user_id") == incoming.get("user_id")
                    and row.get("method") == incoming.get("method")
                    and row.get("wrapper_id", "default") == incoming.get("wrapper_id", "default")
                ),
                None,
            )
            if existing_index is None:
                db["vault_key_wrappers"].append(incoming)
            else:
                current = db["vault_key_wrappers"][existing_index]
                current.update(
                    {
                        "encrypted_vault_key": incoming["encrypted_vault_key"],
                        "salt": incoming["salt"],
                        "iv": incoming["iv"],
                        "wrapper_id": incoming["wrapper_id"],
                        "passkey_credential_id": incoming["passkey_credential_id"],
                        "passkey_prf_salt": incoming["passkey_prf_salt"],
                        "passkey_rp_id": incoming["passkey_rp_id"],
                        "passkey_provider": incoming["passkey_provider"],
                        "passkey_device_label": incoming["passkey_device_label"],
                        "passkey_last_used_at": incoming["passkey_last_used_at"],
                        "updated_at": incoming["updated_at"],
                    }
                )
            return _FakeSQLResult(rows=[{"method": incoming["method"]}], rowcount=1)

        raise RuntimeError(f"Unsupported SQL in fake engine: {sql}")


class _FakeTransactionContext:
    def __init__(self, supabase):
        self._supabase = supabase
        self._snapshot = None

    def __enter__(self):
        self._snapshot = {
            table: [dict(row) for row in rows] for table, rows in self._supabase.db.items()
        }
        return _FakeSQLConnection(self._supabase)

    def __exit__(self, exc_type, exc, _tb):
        if exc_type is not None:
            self._supabase.db = {
                table: [dict(row) for row in rows] for table, rows in self._snapshot.items()
            }
        return False


class _FakeEngine:
    def __init__(self, supabase):
        self._supabase = supabase

    def begin(self):
        return _FakeTransactionContext(self._supabase)


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    def __init__(self, db, table_name):
        self.db = db
        self.table_name = table_name
        self._filters = {}
        self._op = "select"
        self._upsert_data = None
        self._update_data = None
        self._insert_data = None
        self._on_conflict = None

    def select(self, _fields):
        self._op = "select"
        return self

    def eq(self, key, value):
        self._filters[key] = value
        return self

    def limit(self, _count):
        return self

    def upsert(self, data, on_conflict=None):
        self._op = "upsert"
        self._upsert_data = data
        self._on_conflict = on_conflict
        return self

    def delete(self):
        self._op = "delete"
        return self

    def update(self, data):
        self._op = "update"
        self._update_data = data
        return self

    def insert(self, data):
        self._op = "insert"
        self._insert_data = data
        return self

    def _filtered_rows(self):
        rows = self.db[self.table_name]
        for key, value in self._filters.items():
            rows = [row for row in rows if row.get(key) == value]
        return rows

    def execute(self):
        if self._op == "select":
            return _FakeResponse(self._filtered_rows())

        if self._op == "delete":
            keep = []
            for row in self.db[self.table_name]:
                if all(row.get(key) == value for key, value in self._filters.items()):
                    continue
                keep.append(row)
            self.db[self.table_name] = keep
            return _FakeResponse([])

        if self._op == "update":
            for row in self.db[self.table_name]:
                if all(row.get(key) == value for key, value in self._filters.items()):
                    row.update(self._update_data)
            return _FakeResponse(self._filtered_rows())

        if self._op == "insert":
            rows = self._insert_data if isinstance(self._insert_data, list) else [self._insert_data]
            inserted = []
            for incoming in rows:
                self.db[self.table_name].append(dict(incoming))
                inserted.append(dict(incoming))
            return _FakeResponse(inserted)

        if self._op == "upsert":
            rows = self._upsert_data if isinstance(self._upsert_data, list) else [self._upsert_data]
            conflict_fields = [f.strip() for f in (self._on_conflict or "").split(",") if f.strip()]
            for incoming in rows:
                matched_index = None
                if conflict_fields:
                    for idx, existing in enumerate(self.db[self.table_name]):
                        if all(
                            existing.get(field) == incoming.get(field) for field in conflict_fields
                        ):
                            matched_index = idx
                            break
                elif "user_id" in incoming:
                    for idx, existing in enumerate(self.db[self.table_name]):
                        if existing.get("user_id") == incoming.get("user_id"):
                            matched_index = idx
                            break

                if matched_index is None:
                    self.db[self.table_name].append(dict(incoming))
                else:
                    current = self.db[self.table_name][matched_index]
                    current.update(incoming)
            return _FakeResponse(rows)

        return _FakeResponse([])


class _FakeSupabase:
    def __init__(self):
        self.db = {
            "vault_keys": [],
            "vault_key_wrappers": [],
        }
        self.fail_wrapper_methods: set[str] = set()
        self.engine = _FakeEngine(self)

    def table(self, name):
        return _FakeQuery(self.db, name)


@pytest.mark.asyncio
async def test_get_vault_state_returns_multi_wrapper_payload():
    fake = _FakeSupabase()
    fake.db["vault_keys"].append(
        {
            "user_id": "user-1",
            "vault_key_hash": "hash-1",
            "primary_method": "generated_default_web_prf",
            "primary_wrapper_id": "default",
            "recovery_encrypted_vault_key": "recovery-enc",
            "recovery_salt": "recovery-salt",
            "recovery_iv": "recovery-iv",
        }
    )
    fake.db["vault_key_wrappers"] = [
        {
            "user_id": "user-1",
            "method": "passphrase",
            "wrapper_id": "default",
            "encrypted_vault_key": "enc-pass",
            "salt": "salt-pass",
            "iv": "iv-pass",
            "passkey_credential_id": None,
            "passkey_prf_salt": None,
        },
        {
            "user_id": "user-1",
            "method": "generated_default_web_prf",
            "wrapper_id": "default",
            "encrypted_vault_key": "enc-prf",
            "salt": "salt-prf",
            "iv": "iv-prf",
            "passkey_credential_id": "cred-1",
            "passkey_prf_salt": "prf-salt",
            "passkey_rp_id": "localhost",
        },
    ]

    service = VaultKeysService()
    service._supabase = fake

    result = await service.get_vault_state("user-1")

    assert result is not None
    assert result["vaultKeyHash"] == "hash-1"
    assert result["primaryMethod"] == "generated_default_web_prf"
    assert result["primaryWrapperId"] == "default"
    assert len(result["wrappers"]) == 2
    assert {wrapper["method"] for wrapper in result["wrappers"]} == {
        "passphrase",
        "generated_default_web_prf",
    }


@pytest.mark.asyncio
async def test_setup_vault_state_persists_passphrase_required_wrapper_set():
    fake = _FakeSupabase()
    service = VaultKeysService()
    service._supabase = fake

    await service.setup_vault_state(
        user_id="user-1",
        vault_key_hash="vault-hash",
        primary_method="passphrase",
        recovery_encrypted_vault_key="recovery-enc",
        recovery_salt="recovery-salt",
        recovery_iv="recovery-iv",
        primary_wrapper_id="default",
        wrappers=[
            {
                "method": "passphrase",
                "wrapperId": "default",
                "encryptedVaultKey": "enc-pass",
                "salt": "salt-pass",
                "iv": "iv-pass",
            },
            {
                "method": "generated_default_native_biometric",
                "wrapperId": "default",
                "encryptedVaultKey": "enc-bio",
                "salt": "salt-bio",
                "iv": "iv-bio",
            },
        ],
    )

    assert len(fake.db["vault_keys"]) == 1
    assert fake.db["vault_keys"][0]["primary_method"] == "passphrase"
    assert fake.db["vault_keys"][0]["vault_key_hash"] == "vault-hash"
    assert len(fake.db["vault_key_wrappers"]) == 2


@pytest.mark.asyncio
async def test_setup_vault_state_allows_multiple_wrappers_for_same_method(monkeypatch):
    monkeypatch.setenv(
        "PASSKEY_ALLOWED_RP_IDS",
        "localhost,hushh-webapp-1006304528804.us-central1.run.app,app.hushh.ai",
    )

    fake = _FakeSupabase()
    service = VaultKeysService()
    service._supabase = fake

    await service.setup_vault_state(
        user_id="user-1",
        vault_key_hash="vault-hash",
        primary_method="generated_default_web_prf",
        primary_wrapper_id="run-app-rp",
        recovery_encrypted_vault_key="recovery-enc",
        recovery_salt="recovery-salt",
        recovery_iv="recovery-iv",
        wrappers=[
            {
                "method": "passphrase",
                "wrapperId": "default",
                "encryptedVaultKey": "enc-pass",
                "salt": "salt-pass",
                "iv": "iv-pass",
            },
            {
                "method": "generated_default_web_prf",
                "wrapperId": "run-app-rp",
                "encryptedVaultKey": "enc-prf-1",
                "salt": "salt-prf-1",
                "iv": "iv-prf-1",
                "passkeyCredentialId": "cred-1",
                "passkeyPrfSalt": "prf-salt-1",
                "passkeyRpId": "hushh-webapp-1006304528804.us-central1.run.app",
            },
            {
                "method": "generated_default_web_prf",
                "wrapperId": "custom-domain-rp",
                "encryptedVaultKey": "enc-prf-2",
                "salt": "salt-prf-2",
                "iv": "iv-prf-2",
                "passkeyCredentialId": "cred-2",
                "passkeyPrfSalt": "prf-salt-2",
                "passkeyRpId": "app.hushh.ai",
            },
        ],
    )

    wrappers = fake.db["vault_key_wrappers"]
    assert len(wrappers) == 3
    web_prf_wrapper_ids = sorted(
        row["wrapper_id"] for row in wrappers if row["method"] == "generated_default_web_prf"
    )
    assert web_prf_wrapper_ids == ["custom-domain-rp", "run-app-rp"]
    assert fake.db["vault_keys"][0]["primary_wrapper_id"] == "run-app-rp"


def test_allowed_passkey_rp_ids_derive_from_frontend_and_cors(monkeypatch):
    monkeypatch.delenv("PASSKEY_ALLOWED_RP_IDS", raising=False)
    monkeypatch.setenv("FRONTEND_URL", "https://kai.hushh.ai")
    monkeypatch.setenv(
        "CORS_ALLOWED_ORIGINS",
        "https://kai.hushh.ai,https://hushh-webapp-rpphvsc3tq-uc.a.run.app",
    )

    allowed = VaultKeysService._get_allowed_passkey_rp_ids()

    assert "localhost" in allowed
    assert "kai.hushh.ai" in allowed
    assert "hushh-webapp-rpphvsc3tq-uc.a.run.app" in allowed


def test_allowed_passkey_rp_ids_prefer_explicit_allowlist(monkeypatch):
    monkeypatch.setenv(
        "PASSKEY_ALLOWED_RP_IDS",
        "localhost,127.0.0.1,kai.hushh.ai,uat.kai.hushh.ai",
    )
    monkeypatch.setenv("FRONTEND_URL", "https://uat.kai.hushh.ai")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://uat.kai.hushh.ai")

    allowed = VaultKeysService._get_allowed_passkey_rp_ids()

    assert "localhost" in allowed
    assert "kai.hushh.ai" in allowed
    assert "uat.kai.hushh.ai" in allowed


@pytest.mark.asyncio
async def test_setup_vault_state_rejects_duplicate_method_wrapper_pairs():
    fake = _FakeSupabase()
    service = VaultKeysService()
    service._supabase = fake

    with pytest.raises(
        ValueError, match="Duplicate wrapper method \\+ wrapperId pairs are not allowed"
    ):
        await service.setup_vault_state(
            user_id="user-1",
            vault_key_hash="vault-hash",
            primary_method="passphrase",
            primary_wrapper_id="default",
            recovery_encrypted_vault_key="recovery-enc",
            recovery_salt="recovery-salt",
            recovery_iv="recovery-iv",
            wrappers=[
                {
                    "method": "passphrase",
                    "wrapperId": "default",
                    "encryptedVaultKey": "enc-pass",
                    "salt": "salt-pass",
                    "iv": "iv-pass",
                },
                {
                    "method": "passphrase",
                    "wrapperId": "default",
                    "encryptedVaultKey": "enc-pass-2",
                    "salt": "salt-pass-2",
                    "iv": "iv-pass-2",
                },
            ],
        )


@pytest.mark.asyncio
async def test_upsert_wrapper_rejects_vault_key_hash_mismatch():
    fake = _FakeSupabase()
    fake.db["vault_keys"].append(
        {
            "user_id": "user-1",
            "vault_key_hash": "expected-hash",
            "primary_method": "passphrase",
            "primary_wrapper_id": "default",
            "recovery_encrypted_vault_key": "recovery-enc",
            "recovery_salt": "recovery-salt",
            "recovery_iv": "recovery-iv",
        }
    )

    service = VaultKeysService()
    service._supabase = fake

    with pytest.raises(ValueError, match="vaultKeyHash mismatch"):
        await service.upsert_wrapper(
            user_id="user-1",
            vault_key_hash="wrong-hash",
            method="generated_default_native_biometric",
            encrypted_vault_key="enc-bio",
            salt="salt-bio",
            iv="iv-bio",
        )


@pytest.mark.asyncio
async def test_setup_vault_state_requires_passphrase_wrapper():
    fake = _FakeSupabase()
    service = VaultKeysService()
    service._supabase = fake

    with pytest.raises(ValueError, match="Passphrase wrapper is mandatory"):
        await service.setup_vault_state(
            user_id="user-1",
            vault_key_hash="vault-hash",
            primary_method="generated_default_web_prf",
            recovery_encrypted_vault_key="recovery-enc",
            recovery_salt="recovery-salt",
            recovery_iv="recovery-iv",
            primary_wrapper_id="default",
            wrappers=[
                {
                    "method": "generated_default_web_prf",
                    "wrapperId": "default",
                    "encryptedVaultKey": "enc-prf",
                    "salt": "salt-prf",
                    "iv": "iv-prf",
                    "passkeyCredentialId": "cred-1",
                    "passkeyPrfSalt": "prf-salt",
                    "passkeyRpId": "localhost",
                }
            ],
        )


@pytest.mark.asyncio
async def test_setup_vault_state_rolls_back_when_wrapper_insert_fails():
    fake = _FakeSupabase()
    fake.fail_wrapper_methods.add("generated_default_native_biometric")
    service = VaultKeysService()
    service._supabase = fake

    with pytest.raises(RuntimeError, match="forced wrapper insert failure"):
        await service.setup_vault_state(
            user_id="user-rollback",
            vault_key_hash="vault-hash",
            primary_method="passphrase",
            recovery_encrypted_vault_key="recovery-enc",
            recovery_salt="recovery-salt",
            recovery_iv="recovery-iv",
            primary_wrapper_id="default",
            wrappers=[
                {
                    "method": "passphrase",
                    "wrapperId": "default",
                    "encryptedVaultKey": "enc-pass",
                    "salt": "salt-pass",
                    "iv": "iv-pass",
                },
                {
                    "method": "generated_default_native_biometric",
                    "wrapperId": "default",
                    "encryptedVaultKey": "enc-bio",
                    "salt": "salt-bio",
                    "iv": "iv-bio",
                },
            ],
        )

    assert fake.db["vault_keys"] == []
    assert fake.db["vault_key_wrappers"] == []


@pytest.mark.asyncio
async def test_ensure_user_entry_creates_placeholder_row():
    fake = _FakeSupabase()
    service = VaultKeysService()
    service._supabase = fake

    state = await service.ensure_user_entry("user-placeholder")

    assert state["vaultStatus"] == "placeholder"
    assert state["loginCount"] == 1
    assert len(fake.db["vault_keys"]) == 1
    row = fake.db["vault_keys"][0]
    assert row["vault_status"] == "placeholder"
    assert row["vault_key_hash"] is None
    assert row["recovery_encrypted_vault_key"] is None


@pytest.mark.asyncio
async def test_check_vault_exists_false_for_placeholder_and_true_for_active_with_passphrase():
    fake = _FakeSupabase()
    service = VaultKeysService()
    service._supabase = fake

    assert await service.check_vault_exists("user-a") is False

    fake.db["vault_keys"][0]["vault_status"] = "active"
    fake.db["vault_keys"][0]["vault_key_hash"] = "hash"
    fake.db["vault_keys"][0]["recovery_encrypted_vault_key"] = "enc"
    fake.db["vault_keys"][0]["recovery_salt"] = "salt"
    fake.db["vault_keys"][0]["recovery_iv"] = "iv"

    assert await service.check_vault_exists("user-a", ensure_entry=False) is False

    fake.db["vault_key_wrappers"].append(
        {
            "user_id": "user-a",
            "method": "passphrase",
            "wrapper_id": "default",
            "encrypted_vault_key": "enc-pass",
            "salt": "salt-pass",
            "iv": "iv-pass",
        }
    )
    assert await service.check_vault_exists("user-a", ensure_entry=False) is True


@pytest.mark.asyncio
async def test_get_vault_state_returns_none_for_placeholder():
    fake = _FakeSupabase()
    fake.db["vault_keys"].append(
        {
            "user_id": "user-ghost",
            "vault_status": "placeholder",
            "vault_key_hash": None,
            "primary_method": "passphrase",
            "primary_wrapper_id": "default",
            "recovery_encrypted_vault_key": None,
            "recovery_salt": None,
            "recovery_iv": None,
            "created_at": 1,
            "updated_at": 1,
        }
    )

    service = VaultKeysService()
    service._supabase = fake

    result = await service.get_vault_state("user-ghost")
    assert result is None

"""Committed source bindings for one fixed synthetic qualification schema."""

from __future__ import annotations

import hashlib
import json

import release_source
from qualification_target import ABSENT_TABLES, BASELINE, POLICY_SHA256, SOURCE, require

PATH = "deploy/plg/qualification-foundation.json"
METADATA_SHA256 = "f066ad015aba75836ab614b53e4b66d0cb9de3b98b83e25ef3b50a8b13bff738"
OVERLAY_REF = "34401b86f3eb51816a58a55d93c5ae64670e09be"
CLUSTERS = {
    "dev": {
        "systemIdentifier": "7660699789822283792",
        "postgresMajor": 15,
        "observedServerVersionNum": 150018,
    },
    "uat": {
        "systemIdentifier": "7612942862467162128",
        "postgresMajor": 15,
        "observedServerVersionNum": 150018,
    },
}
CLUSTER_EVIDENCE = {
    "sha256": "53b1e0e9fa20c861a4c1001a0b2cad346e637cd02f37b8dd2bc457db6516d855",
    "observedAt": "2026-10-27T18:52:29.002626+00:00",
    "readOnly": True,
    "ownerRowsRead": False,
}
OVERLAYS = (
    (
        "407_plg_memory_revision_index.sql",
        "3249bf736f03c4f107063250ca9120c5ddb5f289b9fdbd01bd9e1cff5be46e7e",
    ),
    (
        "408_validate_plg_memory_revision_index.sql",
        "2a2404ad9c0a3ea180754ee4c6add94114109da71a606f96c68b4b018b601264",
    ),
    (
        "418_account_provider_cleanup_staging.sql",
        "f75c6906339c62ea1d899e78391daa3f3b2188d27a7e2989113cb9d229734139",
    ),
    (
        "419_account_generations.sql",
        "80ef582856e88fde3c0eaff882575e3b31d9252e54f2979ab133597a30c7af5e",
    ),
    (
        "423_account_shared_provider_authority.sql",
        "dbce53cb5423805cbc256288cd728a9f539e7234569ba9a3b16a494325c04efe",
    ),
)
SOURCE_FILES = {
    "consent-protocol/db/migrate.py": "c31971b76b961ac38e467c08a0223ef91324bfb9a4f30168731a08eef09f25db",
    "consent-protocol/db/contracts/prod_core_schema.json": "8930b0719db1e1e36254bcf99273164e204edc6955c66c0d6244e8ee7157b333",
    "consent-protocol/db/release_migration_manifest.json": "72429170876f4e54185def17dfe35e5742b51eeb8d0ebf52f06c6da9826335ff",
    "consent-protocol/db/migrations/020_ria_iam_foundation.sql": "2b21598fbd6ec82e0ee8f866f175d2af2998e345a443c44bd72f961f324004b1",
    "consent-protocol/db/migrations/165_one_referral_program.sql": "9c0b1a5d597064abb6968e9aaf5ed14ed490691834de49c94c4bc7e4c0bf6119",
    "consent-protocol/db/migrations/270_one_referral_gamification_settings.sql": "18335daf3d8d87c1da83416710554314fc9b6c262eac709b25024b40ecc1fb09",
    "consent-protocol/db/migrations/093_consent_audit_request_id_text.sql": "a672bb40d081d2d3c2ce6d810d7e9f047321ad989f69724d027832d9ac2af592",
    "consent-protocol/db/migrations/289_one_referral_program_settings_v2.sql": "52a25acc61327f6b7f3b69c905fae9425844c934ac7a1000e040d7f5b2737c65",
    "consent-protocol/db/migrations/338_one_referral_usd_catalogue.sql": "8dc499738dc5d0e7d5b1d2e7d664c66381b885bf90e9563371f8259ac304fb98",
    "consent-protocol/db/migrations/347_one_referral_dashboard_lifecycle.sql": "2036301cdae30b7786a568b41635d5b331e542bb132677dafb4f3227bfe11279",
    "consent-protocol/db/migrations/349_one_referral_dashboard_truth.sql": "3d160ef807200eb1a2b9ac7aa385199919a92967ab665e46d46d25f175388459",
    "scripts/ops/db_migration_release_guard.py": "26326eedbc884000e7827184ec11cc4c927ce019c304b001a36193467b9c45c3",
    "consent-protocol/requirements.txt": "72da7b26ccda0af3c3691ce655bc2eba7975e9b7ece98bee67cadda2a1198f33",
}
CATALOGS = {
    "consent_scope_templates": {
        "columns": [
            "template_id",
            "version",
            "requester_actor_type",
            "subject_actor_type",
        ],
        "rows": [
            ["investor_advisor_disclosure_v1", 1, "investor", "ria"],
            ["ria_financial_summary_v1", 1, "ria", "investor"],
            ["ria_risk_profile_v1", 1, "ria", "investor"],
        ],
    },
    "one_referral_policies": {"columns": ["version"], "rows": [[1], [2]]},
    "one_referral_program_settings": {
        "columns": ["version", "qualification_policy_version"],
        "rows": [[1, 1], [2, 1], [3, 1], [4, 2], [5, 2]],
    },
}


def binding() -> dict:
    return {
        "schemaVersion": 1,
        "kind": "plg-synthetic-foundation-v1",
        "sourceSha": SOURCE,
        "baselineSha": BASELINE,
        "authorityPolicySha256": POLICY_SHA256,
        "providerContractVersion": 2,
        "requiredAbsentTables": list(ABSENT_TABLES),
        "foundationRelations": ["consent_audit"],
        "legacyUsersRequired": False,
        "initializer": {
            "path": "consent-protocol/db/migrate.py",
            "arguments": ["--init", "--release-environment", "production"],
            "entrypoint": "run_init_migration",
            "runsCanonicalReleaseMigrations": True,
        },
        "initializerThroughMigration": 370,
        "clusterAttestations": CLUSTERS,
        "clusterAttestationEvidence": CLUSTER_EVIDENCE,
        "compatibleOverlayRef": OVERLAY_REF,
        "compatibleOverlays": [
            {
                "path": "consent-protocol/db/migrations/" + name,
                "sha256": digest,
                "transactional": not name.startswith("407_"),
            }
            for name, digest in OVERLAYS
        ],
        "sourceFiles": SOURCE_FILES,
        "sourceSeededCatalogs": CATALOGS,
        "metadataEvidenceSha256": METADATA_SHA256,
    }


def validate_contract(record: dict) -> None:
    expected = binding()
    require(
        isinstance(record, dict)
        and all(
            type(record.get(key)) is type(value)
            and json.dumps(record[key], sort_keys=True) == json.dumps(value, sort_keys=True)
            for key, value in expected.items()
        ),
        "qualification_foundation_contract_mismatch",
    )
    require(
        set(record) == {*expected, "observedConsentAudit", "compatibilityNotes"},
        "qualification_foundation_contract_shape_changed",
    )


def load_contract() -> tuple[dict, str]:
    path = release_source.ROOT / PATH
    require(path.is_file(), "qualification_reviewed_synthetic_foundation_required")
    committed = release_source._git("show", "HEAD:" + PATH)
    require(committed == path.read_bytes(), "qualification_foundation_not_committed")
    release_source._git("diff", "--exit-code", "HEAD", "--", PATH)
    record = json.loads(committed)
    validate_contract(record)
    for source_path, digest in SOURCE_FILES.items():
        content = release_source._git("show", SOURCE + ":" + source_path)
        require(
            hashlib.sha256(content).hexdigest() == digest,
            "qualification_initializer_source_changed",
        )
    overlay_sql()
    return record, hashlib.sha256(committed).hexdigest()


def overlay_sql() -> tuple[tuple[str, bytes], ...]:
    """Read only the reviewed immutable blobs, never a caller-selected SQL path."""
    result = []
    for name, digest in OVERLAYS:
        content = release_source._git(
            "show", OVERLAY_REF + ":consent-protocol/db/migrations/" + name
        )
        require(
            hashlib.sha256(content).hexdigest() == digest,
            "qualification_overlay_source_changed",
        )
        result.append((name, content))
    return tuple(result)


def inspect_catalog(cursor, relation: str) -> None:
    """Finite literal identities only; owner/outbox tables are never exempted."""
    from psycopg2 import sql

    require(relation in CATALOGS, "qualification_catalog_not_admitted")
    definition = CATALOGS[relation]
    columns = sql.SQL(",").join(sql.Identifier(column) for column in definition["columns"])
    cursor.execute(
        sql.SQL("SELECT {} FROM public.{} ORDER BY {}").format(
            columns, sql.Identifier(relation), columns
        )
    )
    require(
        [list(row) for row in cursor.fetchall()] == definition["rows"],
        "qualification_source_catalog_changed",
    )

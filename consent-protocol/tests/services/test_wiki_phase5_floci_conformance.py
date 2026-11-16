# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Phase 5 four-placement conformance & real Floci HTTP/TCP multi-cloud wire verification (#9370)."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import boto3  # type: ignore[import-not-found]
import pytest

from api.routes.one import pod_files
from hushh_eval.wiki_memory import (
    evaluate_four_placement_conformance,
    evaluate_live_wiki_pipeline,
)
from hushh_mcp.services import pod_workload_identity
from hushh_mcp.services.byoc_key_custody import KEY_VAULT_KEY_ENV, KMS_KEY_ENV
from hushh_mcp.services.pod_capability_broker import mint_prefix_gateway_token
from hushh_mcp.services.pod_custody_port import (
    AWS_KMS_KEY_ENV,
    CUSTODY_MODE_ENV,
    CUSTODY_OWNER_KMS,
    CUSTODY_OWNER_VAULT,
    resolve_key_custody_port,
)
from hushh_mcp.services.pod_emulator_endpoints import (
    FLOCI_AZ_ENDPOINT_URL_ENV,
    FLOCI_GCP_ENDPOINT_URL_ENV,
    FLOCI_PREFIX_ALLOW_LOOPBACK_HTTP_ENV,
)
from hushh_mcp.services.pod_files.azure_storage import FilesAzureStore
from hushh_mcp.services.pod_files.storage import FilesGcsStore
from hushh_mcp.services.pod_s3_object_store import (
    FLOCI_ENDPOINT_URL_ENV,
    S3_URI_ENV,
    PrefixTokenObjectStore,
    S3ObjectStore,
    resolve_aws_boto3_client_kwargs,
)
from hushh_mcp.services.wiki_memory import (
    CaptureEventInput,
    WikiKnowledgeWriter,
    WikiLibrary,
    WikiMaintenanceRunner,
    WikiOwnerMigrator,
    WikiProjectionEngine,
    WikiRefused,
)
from tests.floci_wire_harness import (
    floci_aws_wire_environment,
    floci_azure_wire_environment,
    floci_gcp_wire_environment,
    floci_prefix_gateway_environment,
)


async def _noop_check() -> None:
    return None


def _reset_cloud_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "POD_STORAGE_LOCAL_ROOT",
        "POD_STORAGE_GCS_BUCKET",
        "POD_STORAGE_GCS_PREFIX",
        "POD_STORAGE_AZURE_BLOB_URL",
        S3_URI_ENV,
        "POD_STORAGE_PREFIX_TOKEN_URL",
        "POD_STORAGE_PREFIX_BEARER_TOKEN",
        FLOCI_GCP_ENDPOINT_URL_ENV,
        FLOCI_AZ_ENDPOINT_URL_ENV,
        FLOCI_ENDPOINT_URL_ENV,
        FLOCI_PREFIX_ALLOW_LOOPBACK_HTTP_ENV,
        KMS_KEY_ENV,
        KEY_VAULT_KEY_ENV,
        AWS_KMS_KEY_ENV,
        CUSTODY_MODE_ENV,
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
    ):
        monkeypatch.delenv(name, raising=False)


async def _exercise_wiki_over_real_wire_store(
    store: Any,
    *,
    owner: str,
    dek: bytes,
    supports_delete: bool,
) -> None:
    lib = WikiLibrary(
        owner=owner,
        key=dek,
        store=store,
        check=_noop_check,
        account_generation=1,
        library_id="floci_wire",
    )
    writer = WikiKnowledgeWriter(lib)
    projections = WikiProjectionEngine(lib)
    migrator = WikiOwnerMigrator(lib, writer=writer, projections=projections)
    maintenance = WikiMaintenanceRunner(lib, writer=writer, projections=projections)

    await writer.set_capture_opt_in(True)
    cap = await writer.capture_events(
        [
            CaptureEventInput(
                conversation_id="conv_wire",
                event_id="ev_wire_1",
                role="user",
                content="Remember I prefer aisle seats on morning flights.",
            )
        ]
    )
    assert cap["status"] == "saved"

    mig = await migrator.compile_legacy_sources(
        v1_markdown="# memory.md\n\n## Travel\n- Carries Global Entry card.\n",
        idempotency_key="wire_mig_1",
    )
    assert mig["compiled_claim_count"] == 1

    pages = await lib.list_pages()
    travel_summary = next(p for p in pages if p["title"] == "Travel")
    travel_doc = await lib.read_page(travel_summary["page_id"])
    stale_rev = travel_doc["revision"]

    # Two-device optimistic CAS conflict over real HTTP wire ETag/generation
    await lib.edit_page(
        travel_doc["page_id"],
        expected_revision=stale_rev,
        idempotency_key="wire_edit_a",
        tldr="Updated over wire from device A",
    )
    with pytest.raises(WikiRefused) as cas_err:
        await lib.edit_page(
            travel_doc["page_id"],
            expected_revision=stale_rev,
            idempotency_key="wire_edit_b",
            tldr="Stale device B write",
        )
    assert cas_err.value.code == "WIKI_REVISION_CONFLICT"

    refreshed = await lib.read_page(travel_doc["page_id"])
    claim_id = refreshed["claims"][0]["claim_id"]
    rec = await projections.derive_projection(
        page_id=travel_doc["page_id"],
        claim_id=claim_id,
        target_domain="travel",
        json_path="documents.global_entry",
        idempotency_key="wire_proj_1",
        owner_confirmed=True,
    )
    assert rec["state"] == "materialized"

    tick = await maintenance.run_tick(idempotency_key="wire_maint_1")
    assert tick["hot_digest_within_budget"] is True

    forget = await migrator.propagate_forget_and_correction(
        page_id=travel_doc["page_id"],
        claim_id=claim_id,
        idempotency_key="wire_forget_1",
        destroy_page_key=True,
        delete_retired_blobs=supports_delete,
    )
    assert forget["outcomes"]["logical_deletion"] is True
    assert forget["outcomes"]["revoked_future_access"] is True
    assert forget["outcomes"]["key_destroyed"] is True
    assert forget["outcomes"]["physical_erasure_under_retention"] is supports_delete


@pytest.mark.asyncio
async def test_floci_wire_wiki_conformance_over_gcp_gcs_and_kms(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reset_cloud_env(monkeypatch)
    with floci_gcp_wire_environment() as env:
        kms_key = "projects/p-wiki/locations/us-central1/keyRings/kr/cryptoKeys/wiki-kek"
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv(FLOCI_GCP_ENDPOINT_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "hushh-floci-wiki-gcs")
        monkeypatch.setenv("POD_STORAGE_GCS_PREFIX", "pods/usr_gcp_wiki")
        monkeypatch.setenv(CUSTODY_MODE_ENV, CUSTODY_OWNER_KMS)
        monkeypatch.setenv(KMS_KEY_ENV, kms_key)

        dek = resolve_key_custody_port().resolve_log_key()
        store = FilesGcsStore("hushh-floci-wiki-gcs", "pods/usr_gcp_wiki/files/v1")
        retention = await store.verify_bucket(kms_key)
        assert retention["retentionLocked"] is False

        await _exercise_wiki_over_real_wire_store(
            store,
            owner="usr_gcp_wiki",
            dek=dek,
            supports_delete=False,
        )


@pytest.mark.asyncio
async def test_floci_wire_wiki_conformance_over_azure_blob_and_key_vault(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reset_cloud_env(monkeypatch)
    pod_workload_identity.forget_workload_token("https://storage.azure.com")
    pod_workload_identity.forget_workload_token("https://vault.azure.net")
    pod_workload_identity.forget_workload_token("https://management.azure.com/")

    with floci_azure_wire_environment() as env:
        acct = "husshwikiacct"
        account_id = (
            "/subscriptions/11111111-2222-3333-4444-555555555555"
            f"/resourceGroups/rg-wiki/providers/Microsoft.Storage/storageAccounts/{acct}"
        )
        kv_key = f"{env.endpoint_url}/keys/wiki-kek/{'c' * 32}"
        blob_root = f"{env.endpoint_url}/{acct}/pod-wiki/pods/usr_az_wiki"

        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv(FLOCI_AZ_ENDPOINT_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("IDENTITY_ENDPOINT", env.identity_endpoint)
        monkeypatch.setenv("IDENTITY_HEADER", env.identity_header)
        monkeypatch.setenv("AZURE_CLIENT_ID", env.client_id)
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv("POD_STORAGE_AZURE_BLOB_URL", blob_root)
        monkeypatch.setenv(CUSTODY_MODE_ENV, CUSTODY_OWNER_VAULT)
        monkeypatch.setenv(KEY_VAULT_KEY_ENV, kv_key)

        dek = resolve_key_custody_port().resolve_log_key()
        store = FilesAzureStore(f"{blob_root}/files/v1", account_id=account_id)
        retention = await store.verify_bucket(kv_key)
        assert retention["versioning"] is False

        await _exercise_wiki_over_real_wire_store(
            store,
            owner="usr_az_wiki",
            dek=dek,
            supports_delete=True,
        )


@pytest.mark.asyncio
async def test_floci_wire_wiki_conformance_over_aws_s3_and_kms_and_hosted_prefix_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _reset_cloud_env(monkeypatch)
    with floci_aws_wire_environment() as env:
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv("HUSSH_ID", "usr_aws_wiki")
        monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv(S3_URI_ENV, "s3://hushh-floci-wiki-s3/pods/usr_aws_wiki")
        monkeypatch.setenv(CUSTODY_MODE_ENV, CUSTODY_OWNER_KMS)

        s3_admin = boto3.client("s3", **resolve_aws_boto3_client_kwargs("s3"))
        kms_admin = boto3.client("kms", **resolve_aws_boto3_client_kwargs("kms"))
        s3_admin.create_bucket(Bucket="hushh-floci-wiki-s3")
        key_arn = kms_admin.create_key()["KeyMetadata"]["Arn"]
        monkeypatch.setenv(AWS_KMS_KEY_ENV, key_arn)

        dek = resolve_key_custody_port().resolve_log_key()
        s3_store = S3ObjectStore("s3://hushh-floci-wiki-s3/pods/usr_aws_wiki/files/v1")
        await _exercise_wiki_over_real_wire_store(
            s3_store,
            owner="usr_aws_wiki",
            dek=dek,
            supports_delete=True,
        )

    # Zero-IAM Hussh-hosted prefix capability gateway over real loopback HTTP
    _reset_cloud_env(monkeypatch)
    secret = b"floci-prefix-gateway-signing-secret-32b!"
    with floci_prefix_gateway_environment(secret=secret) as gw:
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv(FLOCI_PREFIX_ALLOW_LOOPBACK_HTTP_ENV, "1")
        token, _ = mint_prefix_gateway_token(
            hushh_id="usr_hosted_wiki",
            owner_id="usr_hosted_wiki",
            placement_epoch=1,
            ttl_seconds=900,
            secret=secret,
        )
        prefix_store = PrefixTokenObjectStore(
            f"{gw.endpoint_url}/pods/usr_hosted_wiki",
            bearer_token=token,
        )
        await _exercise_wiki_over_real_wire_store(
            prefix_store,
            owner="usr_hosted_wiki",
            dek=b"\x55" * 32,
            supports_delete=True,
        )


@pytest.mark.asyncio
async def test_phase5_four_placement_matrix_hosted_blocker_and_pod_wiki_routes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    matrix = await evaluate_four_placement_conformance()
    assert matrix["code_conformance_all_passed"] is True
    assert matrix["parent_issue_can_close_done"] is False
    assert "#5507" in str(matrix["parent_close_blocker"])

    by_name = {row["placement"]: row for row in matrix["placements"]}
    assert set(by_name) == {"shared", "byoc_gcp", "byoc_azure", "hussh_hosted"}
    assert by_name["hussh_hosted"]["dev_runtime_acceptance"] == "blocked"
    assert by_name["hussh_hosted"]["blocker_issue"] == "#5507"

    bench = await evaluate_live_wiki_pipeline()
    live = bench["live_encrypted_wiki"]
    assert live["citation_validity_rate"] == 1.0
    assert live["forbidden_leak_count"] == 0
    assert live["hot_digest_within_budget"] is True
    assert live["prompt_chars_p50"] < bench["v1_baseline"]["prompt_chars_p50"]

    # Exercise direct app-role `/api/one/pod/files/wiki/*` route handlers
    _reset_cloud_env(monkeypatch)
    with floci_aws_wire_environment() as env:
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv("HUSSH_ID", "usr_aws_wiki")
        monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, env.endpoint_url)
        s3_admin = boto3.client("s3", **resolve_aws_boto3_client_kwargs("s3"))
        s3_admin.create_bucket(Bucket="hushh-pod-route-wiki")
        store = S3ObjectStore("s3://hushh-pod-route-wiki/pods/usr_route_owner/files/v1")
        wiki = WikiLibrary(
            owner="usr_route_owner",
            key=b"\x66" * 32,
            store=store,
            check=_noop_check,
        )
        await WikiOwnerMigrator(wiki).compile_legacy_sources(
            v1_markdown="# memory.md\n\n## Home\n- Lives near Golden Gate Park.\n",
            idempotency_key="route_seed_1",
        )

        @asynccontextmanager
        async def _fake_wiki_op(*, mutation: bool = False):
            _ = mutation
            yield wiki

        monkeypatch.setattr(pod_files, "wiki_operation", _fake_wiki_op)
        opt_res = await pod_files.update_wiki_opt_in(pod_files.WikiOptInBody(enabled=True), {})
        assert opt_res["captureOptIn"] is True

        ov = await pod_files.read_wiki_overview({})
        assert ov["captureOptIn"] is True
        assert len(ov["pages"]) == 1
        pid = ov["pages"][0]["pageId"]

        detail = await pod_files.read_wiki_page_detail({}, page_id=pid)
        assert detail["title"] == "Home"
        cid = detail["claims"][0]["claimId"]

        forgot = await pod_files.forget_wiki_claim(
            pod_files.WikiForgetClaimBody(
                page_id=pid,
                claim_id=cid,
                request_id="route_forget_req_1",
            ),
            {},
        )
        assert forgot["outcomes"]["logical_deletion"] is True

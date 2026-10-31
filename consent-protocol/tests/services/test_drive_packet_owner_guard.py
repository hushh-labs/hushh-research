"""Owner comparison context preserves authored assessment and source authority.

Synthetic assessments exercise prompt binding, response preservation and schema
refusal; they do not prove live wrong-person detection. Store/worker cases retain
owner isolation, read-only access and failure recovery.
"""

import json
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.exc import ProgrammingError

from hushh_mcp.services.drive_packet_contract import PacketProposal
from hushh_mcp.services.drive_packet_intelligence import (
    EvidenceValidationError,
    construct_packet,
    verify_packet,
)
from hushh_mcp.services.drive_packet_store import DrivePacketStore
from hushh_mcp.services.drive_packet_worker import DrivePacketWorker, compact_evidence
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError

DIFFERENT_PERSON = "Document names a different person"
OWNER_UNCONFIRMED = "Owner name on file cannot confirm the account holder"
OWNER = {"names": ["Manish Example"]}


def cited(value):
    return {"value": value, "citations": [{"page": 1, "quote": value}]}


def statement(
    document_id="only",
    *,
    holder="Jane Example",
    account="Account ending 1122",
    month=9,
    kind="Monthly statement",
):
    window = f"2026-{month:02d}-01", f"2026-{month:02d}-28"
    return {
        "document_id": document_id,
        "source_version": "1",
        "complete": True,
        "facts": {
            "document_type": cited(kind),
            "issuer": cited("Example Bank"),
            "subject": cited(holder) if holder else None,
            "account": cited(account) if account else None,
            "record_status": {
                "status": "unknown",
                "evidence_basis": "unknown",
                "explanation": "Record status was not assessed.",
                "citations": [],
            },
            "periods": [
                {
                    "start": window[0],
                    "end": window[1],
                    "citations": [{"page": 1, "quote": f"Statement period {month:02d}/2026"}],
                }
            ],
            "date_evidence": [],
            "topics": [],
            "facts": [cited("Ending balance $1,000.00")],
            "missing_information": [],
            "ambiguous": False,
        },
    }


def proposal(members):
    return {
        "title": "Example Bank statement",
        "description": "A monthly statement for one account.",
        "state": "ready",
        "selected_document_ids": [item["document_id"] for item in members],
        "excluded_documents": [],
        "coverage_summary": "September 2026.",
        "periods": [period for item in members for period in item["facts"]["periods"]],
        "temporal_scope": "document_period",
        "gaps": [],
        "assessment_score": 90,
        "importance": 50,
        "standalone_value": "supported",
        "utility_rationale": "A complete monthly statement.",
        "pricing": {
            "rubric_version": "drive-packet-price-v1",
            "useful_scope": "period",
            "coverage": "complete",
            "quality": "verified",
            "rationale": "One verified statement period.",
            "suggested_price_cents": 300,
        },
    }


def verdict():
    return {
        "state": "ready",
        "correct_subject_and_account": True,
        "correct_issuer_and_type": True,
        "correct_record_status": True,
        "correct_standalone_value": True,
        "correct_coverage": True,
        "no_unrelated_inclusions": True,
        "no_unexplained_omissions": True,
        "issues": [],
    }


def scope(mode, members):
    return {
        "mode": mode,
        "member_count": len(members),
        "batch_checks_passed": True,
        "batch_issues": [],
        "canonical_key": "example-bank-statements-2026",
    }


async def build(members, owner=OWNER):
    interpreter = AsyncMock(return_value=proposal(members))
    packet = await construct_packet(
        user_id="owner",
        key="example-bank-statements-2026",
        documents=members,
        complete=True,
        interpret=interpreter,
        owner=owner,
    )
    return packet, interpreter


async def check(members, mode="complete_compact_summary", owner=OWNER):
    checker = AsyncMock(return_value=verdict())
    documents = (
        [compact_evidence(item) for item in members] if mode.startswith("complete") else members
    )
    result = await verify_packet(
        user_id="owner",
        packet=proposal(members),
        documents=documents,
        complete=True,
        batch_scope=scope(mode, members),
        interpret=checker,
        owner=owner,
    )
    return result, checker


@pytest.mark.parametrize("owner", [OWNER, {"names": []}, None])
async def test_builder_supplies_owner_context_without_rewriting_the_assessment(owner):
    members = [statement(holder="Jane Example")]
    packet, interpreter = await build(members, owner)
    assert packet.model_dump() == PacketProposal.model_validate(proposal(members)).model_dump()
    prompt = json.loads(interpreter.await_args.kwargs["prompt"])
    assert prompt["owner_identity"] == owner
    assert interpreter.await_count == 1


async def test_authored_wrong_person_assessment_remains_nonready():
    members = [statement(holder="Jane Example")]
    assessment = {**proposal(members), "state": "incomplete", "gaps": [DIFFERENT_PERSON]}
    interpreter = AsyncMock(return_value=assessment)
    packet = await construct_packet(
        user_id="owner",
        key="example-bank-statements-2026",
        documents=members,
        complete=True,
        owner=OWNER,
        interpret=interpreter,
    )
    assert packet.state == "incomplete" and packet.gaps == [DIFFERENT_PERSON]
    with pytest.raises(EvidenceValidationError, match="model_readiness_invalid"):
        await verify_packet(
            user_id="owner",
            packet=packet.model_dump(mode="json"),
            documents=[compact_evidence(item) for item in members],
            complete=True,
            batch_scope=scope("complete_compact_summary", members),
            interpret=AsyncMock(return_value=verdict()),
            owner=OWNER,
        )


@pytest.mark.parametrize("mode", ["complete_compact_summary", "member_batch"])
async def test_checker_supplies_owner_context_without_overruling_a_valid_response(mode):
    result, checker = await check([statement(holder="Jane Example")], mode)
    assert result.model_dump() == verdict()
    prompt = json.loads(checker.await_args.kwargs["prompt"])
    assert prompt["owner_identity"] == OWNER
    assert checker.await_count == 1


async def test_checker_cannot_certify_ready_with_an_explicit_subject_mismatch():
    members = [statement()]
    invalid = {**verdict(), "correct_subject_and_account": False}
    checker = AsyncMock(return_value=invalid)
    with pytest.raises(EvidenceValidationError, match="model_schema_invalid"):
        await verify_packet(
            user_id="owner",
            packet=proposal(members),
            documents=members,
            complete=True,
            batch_scope=scope("member_batch", members),
            interpret=checker,
            owner=OWNER,
        )


class FakePacketStore:
    """The slice of DrivePacketStore one packet job touches, in memory."""

    def __init__(self, job, documents, *, owner=None, owner_error=None):
        self.job, self.documents = job, documents
        self.owner, self.owner_error = owner, owner_error
        self.released, self.committed, self.finalized = [], [], []

    async def claim_packet(self, *, user_id, policy_version):
        return dict(self.job)

    async def owner_identity(self, *, user_id):
        if self.owner_error is not None:
            raise self.owner_error
        return self.owner

    async def require_packet_current(self, job):
        return None

    async def evidence_page(self, job, *, after_document_id=None, limit=6):
        return {"documents": self.documents, "next_cursor": None}

    async def commit_build(self, job, *, build, after_document_id, phase):
        self.committed.append((build, phase))

    async def finalize_packet(self, job, *, assessment, verification):
        self.finalized.append(verification)
        return {"state": verification["state"]}

    async def release_packet(self, job, *, code="packet_unavailable", retryable=True):
        self.released.append((code, retryable))


def job(phase, build=None):
    return {
        "user_id": "owner",
        "key": "example-bank-statements-2026",
        "policy_version": "policy-1",
        "build": build or {},
        "build_phase": phase,
        "after_document_id": None,
        "member_count": 1,
        "attempts": 0,
    }


def worker(store, **fakes):
    return DrivePacketWorker(
        facts_store=object(),
        packet_store=store,
        policy=lambda: "policy-1",
        wake=AsyncMock(),
        placement_resolver=AsyncMock(return_value="shared"),
        **fakes,
    )


async def test_worker_passes_the_owner_on_file_to_the_builder(active_account_lifecycle):
    members = [statement(holder="Jane Example")]
    store = FakePacketStore(job("construct"), members, owner=OWNER)
    constructor = AsyncMock(return_value=proposal(members))
    assert await worker(store, constructor=constructor).run_packet_one(user_id="owner") == (
        "packet_queued"
    )
    assert constructor.await_args.kwargs["owner"] == OWNER
    assert store.committed[0][1] == "verify" and store.released == []


async def test_worker_passes_the_owner_on_file_to_the_final_checker(active_account_lifecycle):
    members = [statement(holder="Jane Example")]
    build = {
        "assessment": proposal(members),
        "policy_version": "policy-1",
        "batch_checks_passed": True,
        "batch_issues": [],
    }
    store = FakePacketStore(job("finalize", build), members, owner=OWNER)
    checker = AsyncMock(return_value=verdict())
    assert await worker(store, checker=checker).run_packet_one(user_id="owner") == "ready"
    assert checker.await_args.kwargs["owner"] == OWNER
    assert checker.await_args.kwargs["batch_scope"]["mode"] == "complete_compact_summary"


async def test_worker_fails_closed_when_the_owner_name_cannot_be_read(active_account_lifecycle):
    members = [statement(holder="Manish Example")]
    store = FakePacketStore(
        job("construct"),
        members,
        owner_error=ConnectorLifecycleError("connector_storage_unavailable"),
    )
    constructor = AsyncMock(return_value=proposal(members))
    assert await worker(store, constructor=constructor).run_packet_one(user_id="owner") == (
        "packet_unavailable"
    )
    assert constructor.await_count == 0
    assert store.released == [("connector_storage_unavailable", True)]


class IdentityCache:
    """A database connection whose schema has, or lacks, the identity cache.

    names=None is a schema without the table, as in the isolated PostgreSQL
    schemas the packet store tests build; the SELECT then fails as it would.
    """

    def __init__(self, names=None):
        self.names, self.statements = names, []

    def execute(self, statement, params=None):
        sql = " ".join(str(statement).split())
        self.statements.append(sql)
        result = MagicMock()
        if "to_regclass('actor_identity_cache')" in sql:
            result.scalar_one.return_value = self.names is not None
        elif "FROM actor_identity_cache" in sql:
            if self.names is None:
                raise ProgrammingError(sql, params, Exception("relation does not exist"))
            user = next(iter(params.values()))
            row = {"display_name": self.names[user]} if user in self.names else None
            result.mappings.return_value.first.return_value = row
        return result


async def read_owner(connection, user_id="owner"):
    store = DrivePacketStore.__new__(DrivePacketStore)

    @contextmanager
    def begin():
        yield connection

    store.db = SimpleNamespace(engine=SimpleNamespace(begin=begin))
    return await store.owner_identity(user_id=user_id)


async def test_store_reads_no_name_where_the_identity_cache_is_absent():
    # Historical isolated schemas can lack the cache; supply explicit absence
    # as assessment context rather than inventing an owner name.
    connection = IdentityCache()
    assert await read_owner(connection) == {"names": []}
    assert not any("FROM actor_identity_cache" in sql for sql in connection.statements)


@pytest.mark.parametrize(
    ("names", "expected"),
    [
        ({"owner": "  Manish Example "}, ["Manish Example"]),
        ({"owner": "   "}, []),
        ({"owner": None}, []),
        ({"someone-else": "Jane Example"}, []),
    ],
    ids=["name_on_file", "blank_name", "null_name", "no_row"],
)
async def test_store_reads_the_owner_name_on_file_and_writes_nothing(names, expected):
    connection = IdentityCache(names)
    assert await read_owner(connection) == {"names": expected}
    assert all(sql.startswith(("SELECT", "SET LOCAL")) for sql in connection.statements)

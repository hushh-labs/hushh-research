"""Provider-free execution contracts for the pinned Gmail donor adapters."""

import asyncio
import base64
import hashlib
import json
import threading
from email import message_from_bytes
from pathlib import Path

import pytest

from hushh_mcp.services.email_oss import gmail_execution as module
from hushh_mcp.services.email_oss.gmail_execution import GmailExecution, GmailExecutionError


def encoded(text):
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def message(identity="m1", *, thread="t1", text="Receipt total INR 12.50"):
    return {
        "id": identity,
        "threadId": thread,
        "snippet": "Receipt",
        "payload": {
            "mimeType": "multipart/mixed",
            "headers": [
                {"name": "Subject", "value": "=?utf-8?b?UmVjZWlwdA==?="},
                {"name": "From", "value": "merchant@example.test"},
                {"name": "Message-ID", "value": "<original@example.test>"},
                {"name": "References", "value": "<earlier@example.test>"},
            ],
            "parts": [
                {"mimeType": "text/plain", "body": {"data": encoded(text)}},
                {
                    "mimeType": "application/pdf",
                    "filename": "invoice.pdf",
                    "body": {"attachmentId": "att1", "size": 18},
                },
            ],
        },
    }


class Request:
    def __init__(self, resource, family, operation, kwargs):
        self.resource, self.family, self.operation, self.kwargs = (
            resource,
            family,
            operation,
            kwargs,
        )

    def execute(self):
        self.resource.calls.append((self.family, self.operation, self.kwargs))
        return self.resource.respond(self.family, self.operation, self.kwargs)


class Api:
    def __init__(self, resource, family="users"):
        self.resource, self.family = resource, family

    def __getattr__(self, name):
        if name in {"messages", "threads", "drafts", "attachments"}:
            return lambda: Api(self.resource, name)
        return lambda **kwargs: Request(self.resource, self.family, name, kwargs)


class Batch:
    def __init__(self, resource, callback):
        self.resource, self.callback, self.requests = resource, callback, []

    def add(self, request, request_id):
        self.requests.append((request_id, request))

    def execute(self):
        self.resource.batches += 1
        # Google may return batch items out of order. Preserve native list order.
        for request_id, request in reversed(self.requests):
            try:
                response = request.execute()
            except Exception as exc:
                self.callback(request_id, None, exc)
            else:
                self.callback(request_id, response, None)


class Resource:
    def __init__(self):
        self.calls, self.batches = [], 0
        self.messages = {"m1": message(), "m2": message("m2")}
        self.page = {
            "messages": [{"id": "m1"}, {"id": "m2"}],
            "nextPageToken": "next1",
            "resultSizeEstimate": 84,
        }
        self.failure = None

    def users(self):
        return Api(self)

    def new_batch_http_request(self, callback):
        return Batch(self, callback)

    def respond(self, family, operation, kwargs):
        if self.failure:
            raise self.failure
        if family == "messages" and operation == "list":
            return self.page
        if family == "messages" and operation == "get":
            value = self.messages[kwargs["id"]]
            if isinstance(value, Exception):
                raise value
            return value
        if family == "threads" and operation == "get":
            return {"id": "t1", "messages": [message()]}
        if family == "attachments":
            raw = b"%PDF synthetic\x00\xff"
            return {"data": base64.urlsafe_b64encode(raw).decode().rstrip("="), "size": len(raw)}
        if family == "drafts":
            return {"id": "draft1"}
        if operation == "send":
            return {"id": "sent1"}
        if operation == "trash":
            return {"id": kwargs["id"]}
        return {}


@pytest.mark.asyncio
async def test_single_page_sdk_batch_keeps_cursor_inventory_and_performs_no_body_extraction(
    monkeypatch,
):
    resource = Resource()
    resource.messages["m1"]["internalDate"] = "1762081380000"
    resource.messages["m1"]["payload"]["headers"].extend(
        [
            {"name": "In-Reply-To", "value": "<parent@example.test>"},
        ]
    )

    def unexpected(_):
        raise AssertionError("metadata listing must not decode message content")

    monkeypatch.setattr(module, "extract_message_part", unexpected)
    previous_page = "previous"
    result = await GmailExecution(resource).search_threads(
        "newer_than:7d", max_results=25, page_token=previous_page
    )
    assert [m["id"] for m in result["messages"]] == ["m1", "m2"]
    assert result["next_page_token"] == "next1"
    assert result["result_size_estimate"] == 84
    assert result["truncated"] and result["returned_count"] == 2
    assert result["messages"][0]["attachments"] == [
        {
            "attachment_id": "att1",
            "filename": "invoice.pdf",
            "mime_type": "application/pdf",
            "size": 18,
        }
    ]
    first = result["messages"][0]
    assert first["internal_date_ms"] == 1762081380000
    assert first["message_id_header"] == "<original@example.test>"
    assert first["in_reply_to"] == "<parent@example.test>"
    assert first["references"] == "<earlier@example.test>"
    assert "body" not in first
    assert resource.batches == 1
    listing = [c for c in resource.calls if c[1] == "list"]
    assert len(listing) == 1 and listing[0][2]["q"] == "newer_than:7d"
    assert listing[0][2]["maxResults"] == 25 and listing[0][2]["pageToken"] == "previous"
    assert all("data" not in c[2]["fields"] for c in resource.calls if c[1] == "get")
    assert not any(c[0] == "attachments" for c in resource.calls)


@pytest.mark.asyncio
async def test_requested_body_uses_vendor_decoder_prefers_plain_and_skips_attachments(monkeypatch):
    resource = Resource()
    resource.messages["m1"]["payload"]["parts"] += [
        {"mimeType": "text/html", "body": {"data": encoded("<p>duplicate</p>")}},
        {
            "mimeType": "text/plain",
            "filename": "secret.txt",
            "body": {"data": encoded("ATTACHMENT CONTENT")},
        },
    ]
    calls = []
    donor = module.extract_message_part

    def observed(payload):
        calls.append(payload)
        return donor(payload)

    monkeypatch.setattr(module, "extract_message_part", observed)
    result = await GmailExecution(resource).search_threads("invoice", include_clean_body=True)
    assert calls and result["messages"][0]["body"] == "Receipt total INR 12.50"
    assert "ATTACHMENT CONTENT" not in json.dumps(result)
    assert all("data" in c[2]["fields"] for c in resource.calls if c[1] == "get")


@pytest.mark.asyncio
async def test_html_charset_and_nested_mime_are_cleaned_without_following_links():
    resource = Resource()
    resource.messages["m1"]["payload"]["parts"] = [
        {
            "mimeType": "text/html",
            "body": {
                "data": encoded(
                    '<script>secret()</script><p>Hello &amp; thank you</p><img src="https://example.test/track">'
                )
            },
        }
    ]
    result = await GmailExecution(resource).get_message("m1")
    assert result["body"] == "Hello & thank you"
    assert len(resource.calls) == 1


@pytest.mark.asyncio
async def test_html_alternative_keeps_only_safe_bounded_action_links_without_changing_plain_body():
    resource = Resource()
    resource.messages["m1"]["payload"]["parts"] += [
        {
            "mimeType": "text/html",
            "body": {
                "data": encoded(
                    '<p>Register <a href="https://summit.example.test/apply?event=21&amp;src=mail">here</a>.</p>'
                    '<a href="javascript:alert(1)">Unsafe</a>'
                    '<a href="https://user:secret@example.test/private">Credential URL</a>'
                )
            },
        },
    ]
    listed = await GmailExecution(resource).search_threads("summit")
    assert "body" not in listed["messages"][0]
    assert "extracted_links" not in listed["messages"][0]
    assert resource.batches == 1

    read = await GmailExecution(resource).get_message("m1")
    assert read["body"] == "Receipt total INR 12.50"
    assert read["extracted_links"] == [
        {
            "text": "here",
            "url": "https://summit.example.test/apply?event=21&src=mail",
        }
    ]
    resource.messages["m1"]["payload"]["parts"] = resource.messages["m1"]["payload"]["parts"][1:]
    html_only = await GmailExecution(resource).get_message("m1")
    assert "[here](https://summit.example.test/apply?event=21&src=mail)" in html_only["body"]
    assert "javascript:" not in json.dumps(html_only)
    assert "user:secret" not in json.dumps(html_only)

    linked_notice = "Event information " * 10 + "booking closes 30 November 2026"
    html_part = next(
        part
        for part in resource.messages["m1"]["payload"]["parts"]
        if part["mimeType"] == "text/html"
    )
    html_part["body"]["data"] = encoded(
        f'<a href="https://summit.example.test/accommodation">{linked_notice}</a>'
    )
    long_link = await GmailExecution(resource).get_message("m1")
    assert "booking closes 30 November 2026" in long_link["body"]
    assert long_link["body_truncated"] is False
    assert len(long_link["extracted_links"][0]["text"]) == 120
    assert long_link["extracted_links"][0]["url"] == "https://summit.example.test/accommodation"


@pytest.mark.asyncio
async def test_recheck_lost_authority_between_list_and_batch_prevents_private_reads():
    resource = Resource()

    async def access():
        if resource.calls:
            raise PermissionError("revoked")

    with pytest.raises(GmailExecutionError):
        await GmailExecution(resource, require_access=access).search_threads("invoice")
    assert [c[1] for c in resource.calls] == ["list"]
    assert resource.batches == 0


@pytest.mark.asyncio
async def test_access_required_before_mutation_and_errors_are_content_free_without_retry():
    resource = Resource()

    async def denied():
        raise PermissionError("revoked")

    with pytest.raises(PermissionError):
        await GmailExecution(resource, require_access=denied).send_email(
            ["a@example.test"], "subject", "private body"
        )
    assert not resource.calls
    resource.failure = RuntimeError("provider echoed private body and credentials")
    with pytest.raises(GmailExecutionError) as error:
        await GmailExecution(resource).send_email(["a@example.test"], "subject", "private body")
    assert str(error.value) == "provider_unavailable" and error.value.outcome_unknown
    assert len(resource.calls) == 1


@pytest.mark.asyncio
async def test_authority_revoked_after_mutation_keeps_uncertain_effect_signal():
    resource = Resource()

    async def access():
        if resource.calls:
            raise PermissionError("owner permission ended")

    with pytest.raises(GmailExecutionError) as error:
        await GmailExecution(resource, require_access=access).create_draft(
            ["a@example.test"], "Subject", "Body"
        )
    assert error.value.code == "permission_denied"
    assert error.value.outcome_unknown is True
    assert [call[:2] for call in resource.calls] == [("drafts", "create")]


@pytest.mark.asyncio
async def test_cancellation_joins_owned_sdk_worker_before_returning_to_resource_owner():
    resource = Resource()
    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    respond = resource.respond

    def blocked_response(family, operation, arguments):
        started.set()
        try:
            if not release.wait(timeout=2):
                raise TimeoutError("synthetic SDK timeout")
            return respond(family, operation, arguments)
        finally:
            finished.set()

    resource.respond = blocked_response
    task = asyncio.create_task(
        GmailExecution(resource).create_draft(["a@example.test"], "Subject", "Body")
    )
    try:
        assert await asyncio.to_thread(started.wait, 1)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done() and not finished.is_set()
        # A second stop while joining must not let the caller close the resource.
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done() and not finished.is_set()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=1)
        assert finished.is_set()
        assert [call[:2] for call in resource.calls] == [("drafts", "create")]
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_vendor_draft_and_send_preserve_recipient_roles_and_do_not_send_a_draft(monkeypatch):
    resource = Resource()
    used = []
    real = module.GmailService.create_draft

    async def observed(self, *args, **kwargs):
        used.append("theposch.create_draft")
        return await real(self, *args, **kwargs)

    monkeypatch.setattr(module.GmailService, "create_draft", observed)
    result = await GmailExecution(resource).create_draft(
        ["to@example.test"], "Thank you", "Body", cc=["cc@example.test"], bcc=["bcc@example.test"]
    )
    assert used == ["theposch.create_draft"] and result["draft_id"] == "draft1"
    assert [c[:2] for c in resource.calls] == [("drafts", "create")]
    mime = message_from_bytes(
        base64.urlsafe_b64decode(resource.calls[0][2]["body"]["message"]["raw"])
    )
    assert (
        mime["To"] == "to@example.test"
        and mime["Cc"] == "cc@example.test"
        and mime["Bcc"] == "bcc@example.test"
    )
    assert mime["From"] is None


@pytest.mark.asyncio
async def test_eaia_reply_preserves_thread_message_id_references_and_exact_recipients(monkeypatch):
    resource = Resource()
    used = []
    real = module.create_message

    def observed(*args, **kwargs):
        used.append("eaia.create_message")
        return real(*args, **kwargs)

    monkeypatch.setattr(module, "create_message", observed)
    result = await GmailExecution(resource).reply_to_thread(
        "t1", ["reviewed@example.test"], "Réponse", cc=["copy@example.test"]
    )
    assert used == ["eaia.create_message"] and result["thread_id"] == "t1"
    outgoing = resource.calls[-1][2]["body"]
    assert outgoing["threadId"] == "t1"
    mime = message_from_bytes(base64.urlsafe_b64decode(outgoing["raw"]))
    assert mime["To"] == "reviewed@example.test"
    assert mime["In-Reply-To"] == "<original@example.test>"
    assert mime["References"] == "<earlier@example.test> <original@example.test>"
    assert mime["Cc"] == "copy@example.test" and mime["From"] is None


@pytest.mark.asyncio
async def test_binary_attachment_is_decoded_bounded_and_never_returned_as_base64(monkeypatch):
    resource = Resource()
    result = await GmailExecution(resource).get_attachment("m1", "att1")
    assert result["content"] == b"%PDF synthetic\x00\xff" and "data" not in result
    monkeypatch.setattr(module, "_MAX_ATTACHMENT_BYTES", 3)
    with pytest.raises(GmailExecutionError, match="response_too_large"):
        await GmailExecution(resource).get_attachment("m1", "att1")


@pytest.mark.asyncio
async def test_partial_batch_failure_keeps_order_and_discloses_failed_count():
    resource = Resource()
    resource.messages["m1"] = RuntimeError("private provider error")
    result = await GmailExecution(resource).search_threads("invoice")
    assert result["failed_count"] == 1 and result["returned_count"] == 1
    assert [m["id"] for m in result["messages"]] == ["m2"]
    assert "private" not in json.dumps(result)


@pytest.mark.asyncio
async def test_transient_batch_read_retries_once_without_changing_page_or_order():
    resource = Resource()
    first = True
    original = resource.respond

    class TemporaryError(Exception):
        resp = type("Response", (), {"status": 503})()

    def respond(family, operation, kwargs):
        nonlocal first
        if family == "messages" and operation == "get" and kwargs["id"] == "m1" and first:
            first = False
            raise TemporaryError("private provider error")
        return original(family, operation, kwargs)

    resource.respond = respond
    result = await GmailExecution(resource).search_threads("summit", max_results=50)
    assert [item["id"] for item in result["messages"]] == ["m1", "m2"]
    assert result["failed_count"] == 0
    assert resource.batches == 2
    assert [call[2]["id"] for call in resource.calls if call[:2] == ("messages", "get")] == [
        "m2",
        "m1",
        "m1",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [0, 51, True])
async def test_search_page_bound_is_enforced_before_provider(count):
    resource = Resource()
    with pytest.raises(GmailExecutionError, match="invalid_argument"):
        await GmailExecution(resource).search_threads("invoice", max_results=count)
    assert not resource.calls


@pytest.mark.asyncio
async def test_modify_trash_and_invalid_header_never_add_unrequested_effects():
    resource = Resource()
    execution = GmailExecution(resource)
    await execution.batch_modify_messages(
        ["m1", "m1", "m2"], add_label_ids=["STARRED"], remove_label_ids=["UNREAD"]
    )
    assert resource.calls[0][2]["body"] == {
        "ids": ["m1", "m2"],
        "addLabelIds": ["STARRED"],
        "removeLabelIds": ["UNREAD"],
    }
    await execution.trash_message("m1")
    assert resource.calls[1][:2] == ("messages", "trash")
    with pytest.raises(GmailExecutionError, match="invalid_argument"):
        await execution.create_draft(["a@example.test"], "Subject\r\nBcc: bad@example.test", "Body")
    assert len(resource.calls) == 2


def test_pinned_original_source_and_license_hashes_are_preserved():
    vendor = Path(module.__file__).parent / "vendor"
    manifest = json.loads((vendor / "PROVENANCE.json").read_text())
    assert {entry["commit"] for entry in manifest["sources"]} == {
        "f4c8affe8c08b0fb3deb33570251ed0596e73d9d",
        "758db7174223da7864feea7c9f8d1aba12923037",
        "603fc7a4ac6119004f43894395e504a1fefcc6c0",
    }
    for source in manifest["sources"]:
        for file in source["files"]:
            assert (
                hashlib.sha256((vendor / file["path"]).read_bytes()).hexdigest() == file["sha256"]
            )


@pytest.mark.asyncio
async def test_oversized_gmail_search_can_shrink_once_without_advancing_cursor():
    import json

    from langchain_core.messages import AIMessage, ToolMessage

    from tests.helpers.email_oss import Execution, call, make_runtime, turn

    class OversizedExecution(Execution):
        async def search_threads(self, **kwargs):
            self.calls.append(kwargs)
            if kwargs["max_results"] == 25:
                return {"messages": [{"id": "large", "body": "x" * (256 * 1024)}]}
            return {"messages": [{"id": "m1"}], "next_page_token": "new-cursor"}

    execution = OversizedExecution()
    initial = {"q": "invoice newer_than:7d", "include_clean_body": True}
    runtime, model, _ = make_runtime(
        [
            AIMessage(content="", tool_calls=[call("search_threads", initial, "initial")]),
            AIMessage(
                content="",
                tool_calls=[
                    call(
                        "search_threads",
                        {**initial, "max_results": 5, "page_token": "other"},
                        "wrong",
                    ),
                ],
            ),
            AIMessage(
                content="",
                tool_calls=[
                    call("search_threads", {**initial, "max_results": 5}, "repair"),
                ],
            ),
            AIMessage(
                content="",
                tool_calls=[
                    call("search_threads", {**initial, "page_token": "new-cursor"}, "next"),
                ],
            ),
            AIMessage(content="Here is one result. There are more on the next page."),
        ],
        execution=execution,
    )
    result = await runtime.handle_turn(**turn())
    assert result["status"] == "ok"
    assert result["structured"]["status"] == "ok"
    assert result["structured"]["truncation_reasons"] == ["more_pages"]
    assert execution.calls == [
        {**initial, "max_results": 25, "page_token": None},
        {**initial, "max_results": 5, "page_token": None},
    ]
    results = {
        m.tool_call_id: json.loads(m.content) for m in model.seen[-1] if isinstance(m, ToolMessage)
    }
    assert results["initial"]["code"] == "response_too_large"
    assert results["wrong"]["code"] == "search_correction_required"
    assert results["next"]["code"] == "page_requires_next_user_turn"

"""Shared fake provider/model ports for native graph contract proofs."""

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from pydantic import Field

from hushh_mcp.services.email_oss.runtime import EmailAgentRuntime


class ToolModel(FakeMessagesListChatModel):
    seen: list = Field(default_factory=list)
    bound_tools: list[str] = Field(default_factory=list)

    def bind_tools(self, tools, **kwargs):
        self.bound_tools = [tool.name for tool in tools]
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(messages)
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


class Execution:
    def __init__(self):
        self.calls = []

    async def search_threads(self, **kwargs):
        self.calls.append(("search_threads", kwargs))
        return {
            "messages": [{"id": "m1", "subject": "Invoice", "amount": None}],
            "returned_count": 1,
            "truncated": False,
        }

    async def send_email(self, **kwargs):
        self.calls.append(("send_email", kwargs))
        return {"status": "sent", "message_id": "sent1"}

    async def create_draft(self, **kwargs):
        self.calls.append(("create_draft", kwargs))
        return {"status": "draft_created", "draft_id": "draft1"}

    async def get_message(self, **kwargs):
        self.calls.append(("get_message", kwargs))
        return {
            "id": "m1",
            "attachments": [
                {"attachment_id": "a1", "mime_type": "application/pdf", "filename": "invoice.pdf"}
            ],
        }

    async def get_attachment(self, **kwargs):
        self.calls.append(("get_attachment", kwargs))
        return {"content": b"%PDF-test", "size": 9}


async def access():
    pass


def call(name, args, identity="call-1"):
    return {"name": name, "args": args, "id": identity, "type": "tool_call"}


def make_runtime(responses, *, execution=None, **kwargs):
    model = ToolModel(responses=responses)
    service = execution or Execution()
    return (
        EmailAgentRuntime(
            model_factory=lambda ctx: model, execution_factory=lambda ctx: service, **kwargs
        ),
        model,
        service,
    )


def turn(**kwargs):
    return {
        "user_id": "owner",
        "message": "Find invoices this week",
        "conversation_id": "conversation",
        "require_access": access,
        **kwargs,
    }

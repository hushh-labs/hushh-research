"""Compose the existing Email hands into their one authored native-tool catalog."""

from langchain_core.tools import StructuredTool

from .effect_tools import GmailEffectTools
from .memory_tools import EmailMemoryTools
from .read_tools import GmailReadTools
from .tool_inputs import (
    _Attachment,
    _DraftEnvelope,
    _Empty,
    _Envelope,
    _Message,
    _Modify,
    _ReadMemory,
    _Reply,
    _SaveMemory,
    _Search,
    _Thread,
)

_DEFINITIONS = [
    (
        "search_threads",
        _Search,
        "Search live Gmail with the owner's query. One page only; default 25, at most 50. A next_page_token signals more results, never auto-fetches them.",
    ),
    (
        "get_message",
        _Message,
        "Read one exact Gmail message, its clean body and attachment inventory.",
    ),
    ("get_thread", _Thread, "Read the messages of one exact Gmail conversation."),
    (
        "get_attachment",
        _Attachment,
        "Read one inventoried PDF or CSV attachment through the existing scanner and isolated parser. Other formats remain unavailable; no model extraction call.",
    ),
    (
        "create_draft",
        _DraftEnvelope,
        "Create a text/HTML Gmail-native draft from the owner's explicit request. This saves a draft, never sends it. Outgoing file attachments are not supported by this tool.",
    ),
    (
        "send_email",
        _Envelope,
        "Request the existing owner's review for the exact plain-text email envelope; HTML and outgoing file attachments are unsupported. Send only with its current exact ledger receipt; pending review is not sent.",
    ),
    (
        "reply_to_thread",
        _Reply,
        "Request review of a reply in an exact original Gmail thread. Preserve sender and thread from the source; pending review is not sent.",
    ),
    (
        "batch_modify_messages",
        _Modify,
        "Request review for at most 25 exact Gmail message label changes, including read/archive state. No change without the existing exact approval.",
    ),
    (
        "trash_message",
        _Message,
        "Request owner review before moving one exact message to recoverable Gmail Trash.",
    ),
    (
        "get_connection_status",
        _Empty,
        "Read actual owner connection status without reading mailbox contents. Unknown status is not disconnected or sync complete.",
    ),
    (
        "read_memory_md",
        _ReadMemory,
        "Read the owner's authorized current memory.md projection, optionally one exact section. This does not fetch Gmail.",
    ),
    (
        "save_to_memory_md",
        _SaveMemory,
        "Calculate receipt totals exactly by currency AND propose their memory summary: for any receipt/expense/invoice total, call this tool with receipt_rows before answering, even if memory saving was not requested. It computes Decimal arithmetic; never add financial amounts mentally. This tool does not commit memory: its proposal requires owner confirmation through the encrypted writer. Also proposes contact/project/preference facts. Pending client commit is not saved.",
    ),
]

READ_NAMES = (
    "search_threads",
    "get_message",
    "get_thread",
    "get_attachment",
    "get_connection_status",
)

EFFECT_NAMES = (
    "create_draft",
    "send_email",
    "reply_to_thread",
    "batch_modify_messages",
    "trash_message",
)

TOOL_NAMES = tuple((name for name, _, _ in _DEFINITIONS))


def build_tools(state):
    reads, effects, memory = (
        GmailReadTools(state),
        GmailEffectTools(state),
        EmailMemoryTools(state),
    )
    owners = {name: reads for name in READ_NAMES}
    owners.update({name: effects for name in EFFECT_NAMES})
    owners.update({name: memory for name in ("read_memory_md", "save_to_memory_md")})
    return [
        StructuredTool.from_function(
            coroutine=getattr(owners[name], name),
            name=name,
            description=description,
            args_schema=schema,
        )
        for name, schema, description in _DEFINITIONS
    ]

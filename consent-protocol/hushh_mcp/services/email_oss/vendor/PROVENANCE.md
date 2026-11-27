# Pinned Gmail execution sources

**License exception: theposch/gmail-mcp is GPL version 3.** Its source, adapted
execution module and the integrating Gmail execution adapter are not licensed
under the enclosing first-party Apache-2.0 default. The complete upstream GPL
text is retained at [theposch/original/LICENSE](theposch/original/LICENSE).
EAIA and agents-from-scratch retain their respective MIT notices and licenses.
Importing these modules does not change their licenses. Distribution of the
integrated work must retain the GPL obligations; this is not a claim that an
Apache-only package can be published unchanged.

`PROVENANCE.json` records exact repositories, immutable commits, copied paths and
SHA-256 hashes. `original/` contains byte-for-byte upstream source, including
upstream auth/demo code for provenance only. **Git attributes retain the archives' original bytes/whitespace; runtime adaptations
remain subject to the normal formatting and security gates.
Original source archives use `.py.upstream` so they cannot be imported
or executed as runtime modules.** Only the named, explicitly adapted execution helpers below run.
Do not run the original files: they can open local OAuth flows, log private
information and, in the scratch demo, return mock provider results.

## theposch/gmail-mcp

- Commit: `f4c8affe8c08b0fb3deb33570251ed0596e73d9d`
- Source: <https://github.com/theposch/gmail-mcp/blob/f4c8affe8c08b0fb3deb33570251ed0596e73d9d/src/gmail/server.py>
- Original: `theposch/original/src/gmail/server.py.upstream`, GPL-3.0.
- Runtime extraction: `theposch/execution.py`.

Actual upstream functions used directly by `GmailExecution`: `decode_mime_header`
(166–178), `GmailService.send_email` (236–255), `create_draft` (389–408),
`trash_email` (371–378), and `search_emails` (661–731).

Minimal adaptations:

1. Replace the file-OAuth/profile constructor with an injected operation-scoped
   googleapiclient resource. Remove MCP/server/browser/auth imports and all logs.
2. Factor the repeated `EmailMessage` construction from send/create into
   `_message`. Omit `From` so Gmail assigns its authenticated `me` sender; accept
   Cc/Bcc and optional HTML. Retain the original drafts.create/messages.send SDK
   calls, MIME/base64 transport and acknowledgment IDs.
3. Replace upstream error strings with exception propagation to the host's fixed,
   content-free error envelope. Offload trash execution to the same thread boundary
   as send/create. No retry is added.
4. Search executes exactly one native messages.list page and returns its token.
   Remove upstream automatic pagination and per-message sequential retrieval;
   the host performs one bounded SDK HTTP batch and projects results in list order.
5. Header decoding uses replacement characters for malformed bytes and falls back
   to UTF-8 for unknown charset labels.

The donor **does not implement** `get_attachment`, `get_thread`, SDK HTTP batching
or `batchModify`. Those are explicitly new thin native-API operations in
`gmail_execution.py`, not invented code described as vendored. Its `read_email`
automatically marks mail read; that function is deliberately not imported. The
host's explicit read methods have no mailbox mutation side effect.

## LangChain executive-ai-assistant (EAIA)

- Commit: `758db7174223da7864feea7c9f8d1aba12923037`
- Source: <https://github.com/langchain-ai/executive-ai-assistant/blob/758db7174223da7864feea7c9f8d1aba12923037/eaia/gmail.py>
- Original: `eaia/original/eaia/gmail.py.upstream`, MIT (Copyright 2024 LangChain).
- Runtime extraction: `eaia/execution.py`, `create_message` (112–124) and
  `send_message` (147–149).

`send_message` preserves its native SDK execution. `create_message` preserves
MIMEMultipart/MIMEText encoding, Message-ID, In-Reply-To and threadId; it accepts
an existing References chain and Cc/Bcc, and omits From when no sender is supplied.
The host re-reads the exact thread's original Message-ID and References and uses
only the caller's explicitly reviewed recipients. Upstream substring-based
recipient inference, LangChain auth client, global scopes, polling and logging
are not imported.

## LangChain agents-from-scratch

- Commit: `603fc7a4ac6119004f43894395e504a1fefcc6c0`
- Source: <https://github.com/langchain-ai/agents-from-scratch/blob/603fc7a4ac6119004f43894395e504a1fefcc6c0/src/email_assistant/tools/gmail/gmail_tools.py>
- Original: `agents_from_scratch/original/src/email_assistant/tools/gmail/gmail_tools.py.upstream`,
  MIT (Copyright 2026 LangChain, Inc.).
- Runtime extraction: `agents_from_scratch/mime.py`, `extract_message_part`
  (43–61), unchanged function logic, moved out of its optional-import block.

The host validates MIME depth/part/byte bounds, skips attachment parts, normalizes
base64 padding and charset to UTF-8, calls this actual decoder, prefers plain text
over HTML alternatives, and cleans HTML with the existing first-party
`gmail_message_text` helper. Metadata-only listing does not call the decoder.
No scratch demo model, OAuth, mocks, send/calendar tools or automatic mark-read
graph is executed. This is execution-helper reuse, not a claim that the upstream
agent graph has been vendored into the runtime.

## Host additions and limits

`GmailExecution(service, require_access=...)` owns no credential or consent store.
The runtime provides a separate resource with the correct read/compose/send/modify
token for each operation and owns closing it. The optional access callback is
checked before/after execution and between list/batch or thread-read/send. The
runtime must enforce its existing send/modify review before invoking mutators.
No invocation implies authorization; no exception triggers a retry.

`search_threads` is the compatibility method name for a native **message** search
page carrying thread IDs; it does not substitute a latest-thread message for the
provider's matching message. Max results is 50, one list page, one SDK batch,
no automatic next page. Ordinary listing uses `format=full` with an explicit field
mask omitting every `body.data` but retaining MIME attachment inventory. This
avoids claiming that Gmail's header-only `metadata` format exposes filenames.
The tree mask is depth-bounded; `attachment_inventory_complete=false` exposes a
multipart tree reaching the boundary. Body mode adds inline body data; it does
not issue attachment downloads. Large provider messages are rejected, body text
is capped at 32 KiB with a truncation flag, and a thread returns at most 50 messages.

Attachment retrieval is a separate explicit operation, limited to 10 MiB decoded.
It returns bytes only to the runtime parser port; never base64 to a model. MIME
type/filename must come from the original message inventory, because Gmail's
attachment endpoint returns neither. No PDF/CSV interpretation or semantic stage
is added here. SDK batches are serialized on the resource because httplib2 is not
thread-safe. Provider-free SDK doubles verify wire contracts; they do not prove
installed SDK, OAuth or live Gmail behavior.

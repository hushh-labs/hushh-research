"""Trusted isolated-world receipt for clearing fields after form serialization.

A Document Fetch pause may prevent evaluating its old Playwright context. The
native formdata event already has the serialized body; clear the selected input
values synchronously there, then acknowledge through a binding available only
inside this isolated world. No secret value is sent in the receipt.
"""

from __future__ import annotations

import asyncio
import json
from uuid import uuid4

from .contracts import BrowserRefused

_TARGETS = """
  if (location.origin !== options.origin) throw new Error('refused');
  const selected = Object.fromEntries(Object.entries(options.points).map(([name, point]) =>
    [name, document.elementFromPoint(point.x, point.y)]));
  const form = selected.password?.form;
  if (new Set(Object.values(selected)).size !== Object.keys(selected).length || !form ||
      selected.password.type !== 'password' || form !== selected.submit?.form ||
      form.method.toLowerCase() !== 'post' || new URL(form.action).origin !== options.origin ||
      (form.target && form.target !== '_self') ||
      Object.entries(selected).some(([name, el]) => !el || el.ownerDocument !== document ||
        !el.isConnected || el.disabled || (name !== 'submit' && (el.tagName !== 'INPUT' || el.form !== form)))) throw new Error('refused');
  const submit = selected.submit;
  if (!['BUTTON','INPUT'].includes(submit.tagName) || submit.type !== 'submit' ||
      (submit.formTarget && submit.formTarget !== '_self') ||
      (submit.getAttribute('formmethod') && submit.formMethod.toLowerCase() !== 'post') ||
      (submit.getAttribute('formaction') && new URL(submit.formAction).origin !== options.origin) ||
      !['text','email'].includes(selected.username.type) ||
      (selected.otp && selected.otp.type !== 'password' && selected.otp.autocomplete !== 'one-time-code')) throw new Error('refused');
  const actionURL = submit.getAttribute('formaction') ? submit.formAction : form.action;
  const encoding = submit.getAttribute('formenctype') ? submit.formEnctype : form.enctype;
  if (options.expected && (actionURL !== options.expected.action_url || encoding !== options.expected.encoding)) throw new Error('refused');
"""


async def trusted_value(cdp, frame_id, script, arguments):
    if cdp is None or frame_id is None:
        raise BrowserRefused("BROWSER_SECRET_CLEANUP_UNCONFIRMED")
    world = await cdp.send(
        "Page.createIsolatedWorld", {"frameId": frame_id, "worldName": "hussh-credential-guard"}
    )
    result = await cdp.send(
        "Runtime.evaluate",
        {
            "contextId": world["executionContextId"],
            "expression": "(" + script + ")(" + json.dumps(arguments) + ")",
            "returnByValue": True,
        },
    )
    return None if result.get("exceptionDetails") else result.get("result", {}).get("value")


async def trusted_boolean(cdp, frame_id, script, arguments):
    return await trusted_value(cdp, frame_id, script, arguments) is True


async def require_verifiable_shadow_roots(cdp) -> None:
    """Closed roots and embedded documents cannot be attested by this guard.

    CDP reports their existence independently of page-controlled JavaScript.
    Native user-agent roots remain covered through their host's native value
    getter; an absent/malformed discovery result is never evidence of safety.
    """
    try:
        result = await cdp.send("DOM.getDocument", {"depth": -1, "pierce": True})
        root = result["root"]
        if root.get("nodeType") != 9:
            raise ValueError()
        pending = [root]
        while pending:
            node = pending.pop()
            if node.get("nodeName", "").upper() in ("IFRAME", "FRAME", "OBJECT", "EMBED"):
                raise ValueError()
            if node.get("shadowRootType") not in (None, "open", "user-agent"):
                raise ValueError()
            for key in ("children", "shadowRoots"):
                children = node.get(key, [])
                if not isinstance(children, list):
                    raise ValueError()
                pending.extend(children)
            if node.get("contentDocument") is not None:
                raise ValueError()
    except Exception:
        raise BrowserRefused("BROWSER_SECRET_OBSERVATION_UNVERIFIABLE") from None


class SerializedFormCleanup:
    def __init__(self, cdp, frame_id: str, *, expected_target=None) -> None:
        self.cdp, self.frame_id = cdp, frame_id
        self.name = "husshCredentialCleanup" + uuid4().hex
        self.nonce = uuid4().hex
        self.context_id = None
        self.receipt = asyncio.Event()
        self.authentication = None
        self.expected_target = expected_target

    def received(self, event):
        if (event.get("name"), event.get("executionContextId")) != (self.name, self.context_id):
            return
        try:
            payload = event.get("payload")
            if not isinstance(payload, str) or len(payload) > 8192:
                return
            value = json.loads(payload)
            if value.get("nonce") != self.nonce or set(value) - {"nonce", "authentication"}:
                return
            candidate = value.get("authentication")
            if isinstance(candidate, dict) and set(candidate) == {"action_url", "body_sha256"}:
                self.authentication = candidate
            self.receipt.set()
        except (ValueError, TypeError, AttributeError):
            return

    async def safe_boolean(self, script, arguments):
        return await trusted_boolean(self.cdp, self.frame_id, script, arguments)

    async def verify(self, request):
        result = await trusted_value(
            self.cdp,
            self.frame_id,
            "options => {" + _TARGETS + "return {action_url:actionURL, encoding};}",
            {
                "points": request.targets.model_dump(exclude_none=True),
                "origin": request.origin,
                "expected": self.expected_target,
            },
        )
        if not isinstance(result, dict) or set(result) != {"action_url", "encoding"}:
            raise BrowserRefused("BROWSER_CREDENTIAL_TARGET_REFUSED")
        return result

    async def arm(self, request):
        result = await self.cdp.send(
            "Page.createIsolatedWorld",
            {
                "frameId": self.frame_id,
                "worldName": self.name,
            },
        )
        self.context_id = result["executionContextId"]
        self.cdp.on("Runtime.bindingCalled", self.received)
        await self.cdp.send(
            "Runtime.addBinding", {"name": self.name, "executionContextId": self.context_id}
        )
        options = json.dumps(
            {
                "name": self.name,
                "nonce": self.nonce,
                "points": request.targets.model_dump(exclude_none=True),
                "origin": request.origin,
                "expected": self.expected_target,
            }
        )
        result = await self.cdp.send(
            "Runtime.evaluate",
            {
                "contextId": self.context_id,
                "expression": "(options => {"
                + _TARGETS
                + """
              const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
              const fields = Object.entries(selected).filter(([name]) => name !== 'submit').map(([, el]) => el);
              const clear = async event => {
                const data = event.formData;
                fields.forEach(el => descriptor.set.call(el, ''));
                if (!fields.every(el => descriptor.get.call(el) === '')) return;
                const receipt = {nonce:options.nonce};
                // Native standard form serialization only, no request guessing.
                if (encoding === 'application/x-www-form-urlencoded' && [...data.values()].every(value => typeof value === 'string')) {
                  let body;
                  try {
                    body = new TextEncoder().encode(new URLSearchParams(data).toString());
                    const digest = await crypto.subtle.digest('SHA-256', body);
                    receipt.authentication = {action_url:actionURL,body_sha256:[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')};
                  } catch {} finally { body?.fill(0); }
                }
                globalThis[options.name](JSON.stringify(receipt));
              };
              form.addEventListener('formdata', clear, {once:true});
              globalThis[options.name + 'Remove'] = () => form.removeEventListener('formdata', clear);
              return true;
            })("""
                + options
                + ")",
                "returnByValue": True,
            },
        )
        if result.get("exceptionDetails") or result.get("result", {}).get("value") is not True:
            raise BrowserRefused("BROWSER_SECRET_CLEANUP_UNCONFIRMED")

    async def require_receipt(self):
        try:
            await asyncio.wait_for(self.receipt.wait(), 5)
        except TimeoutError:
            raise BrowserRefused("BROWSER_SECRET_CLEANUP_UNCONFIRMED") from None

    async def close(self):
        self.cdp.remove_listener("Runtime.bindingCalled", self.received)
        try:
            if self.context_id is not None:
                # A destroyed document already destroyed its isolated listener.
                await self.cdp.send(
                    "Runtime.evaluate",
                    {
                        "contextId": self.context_id,
                        "expression": f"globalThis[{json.dumps(self.name + 'Remove')}]?.()",
                    },
                )
            await self.cdp.send("Runtime.removeBinding", {"name": self.name})
        except Exception:
            pass  # No listener/receipt is usable after this transaction closes.

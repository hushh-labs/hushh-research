"""Explicit-target private entry; no login detection or DOM control inference.

Playwright and Chromium necessarily copy decoded strings. The mutable source
buffers are erased by the caller; this adapter clears fields and disposes remote
handles. It does not claim to overwrite immutable driver or renderer memory.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import time
from collections.abc import Awaitable, Callable

from .contracts import BrowserRefused
from .credential_contracts import CredentialLease, CredentialUseRequest
from .origin import public_origin


def totp(secret: bytearray, *, now: float | None = None) -> bytearray:
    key = bytearray()
    try:
        key.extend(
            base64.b32decode(bytes(secret).upper() + b"=" * (-len(secret) % 8), casefold=True)
        )
        if not 10 <= len(key) <= 128:
            raise ValueError()
        digest = hmac.digest(
            key, int((time.time() if now is None else now) // 30).to_bytes(8, "big"), hashlib.sha1
        )
        offset = digest[-1] & 15
        number = (int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF) % 1_000_000
        return bytearray(f"{number:06d}".encode("ascii"))
    except (ValueError, TypeError):
        raise BrowserRefused("BROWSER_CREDENTIAL_OTP_INVALID") from None
    finally:
        key[:] = b"\0" * len(key)


async def require_clear_inputs(
    page, *, cdp=None, frame_id=None, private_entry: bool = False
) -> None:
    from .playwright_secret_cleanup import require_verifiable_shadow_roots, trusted_boolean

    # Explicit owner handback retains its existing top-document clear-field
    # check. Automatic private entry additionally attests its supported DOM.
    if private_entry:
        await require_verifiable_shadow_roots(cdp)
    if not await trusted_boolean(
        cdp,
        frame_id,
        """privateEntry => {
        const getter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get;
        const shadow = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot').get;
        const roots = [document];
        for (let index = 0; index < roots.length; index++) {
          for (const el of roots[index].querySelectorAll('*')) {
            if (el instanceof HTMLInputElement &&
                (el.type === 'password' || el.autocomplete === 'one-time-code') &&
                getter.call(el).length !== 0) return false;
            if (privateEntry) {
              const nested = shadow.call(el);
              if (nested) roots.push(nested);
            }
          }
        }
        return true;
    }""",
        private_entry,
    ):
        raise BrowserRefused("BROWSER_SECRET_FIELDS_NOT_CLEARED")


class PrivateEntryTargets:
    def __init__(self, page, request: CredentialUseRequest, *, navigation_cleanup=None) -> None:
        self.page, self.request = page, request
        self.elements: dict = {}
        self.cleared = False
        self.submitting = False
        self.original_cleared = False
        self.navigation_cleanup = navigation_cleanup
        self._otp_code = None

    async def verify(self) -> None:
        if self.navigation_cleanup is not None:
            self.target_receipt = await self.navigation_cleanup.verify(self.request)
        if public_origin(self.page.url) != self.request.origin:
            raise BrowserRefused("BROWSER_CREDENTIAL_ORIGIN_CHANGED")
        for name, target in self.request.targets.model_dump(exclude_none=True).items():
            handle = await self.page.evaluate_handle(
                "({x,y}) => document.elementFromPoint(x,y)", target
            )
            element = handle.as_element()
            if element is None:
                await handle.dispose()
                raise BrowserRefused("BROWSER_CREDENTIAL_TARGET_REFUSED")
            self.elements[name] = element
            valid = await element.evaluate(
                """(el, kind) => {
              if (el.ownerDocument !== document || !el.isConnected || el.disabled) return false;
              if (kind === 'submit') return (el.tagName === 'BUTTON' && el.type === 'submit') ||
                (el.tagName === 'INPUT' && el.type === 'submit');
              if (el.tagName !== 'INPUT') return false;
              if (kind === 'password') return el.type === 'password';
              if (kind === 'otp') return el.type === 'password' || el.autocomplete === 'one-time-code';
              return el.type === 'text' || el.type === 'email';
            }""",
                name,
            )
            if not valid or not await element.is_visible():
                raise BrowserRefused("BROWSER_CREDENTIAL_TARGET_REFUSED")
        values = list(self.elements.values())
        for index, element in enumerate(values):
            for other in values[index + 1 :]:
                if not await element.evaluate("(el, other) => el !== other", other):
                    raise BrowserRefused("BROWSER_CREDENTIAL_TARGET_REFUSED")
        await self.recheck()

    async def recheck(self) -> None:
        if self.navigation_cleanup is not None:
            self.target_receipt = await self.navigation_cleanup.verify(self.request)
        if public_origin(self.page.url) != self.request.origin:
            raise BrowserRefused("BROWSER_CREDENTIAL_ORIGIN_CHANGED")
        submit = self.elements["submit"]
        for name, target in self.request.targets.model_dump(exclude_none=True).items():
            if not await self.elements[name].evaluate(
                """(el, point) => el.isConnected && !el.disabled &&
                el.ownerDocument === document && document.elementFromPoint(point.x,point.y) === el""",
                target,
            ):
                raise BrowserRefused("BROWSER_CREDENTIAL_TARGET_CHANGED")
            if name != "submit" and not await self.elements[name].evaluate(
                """(el, submit) =>
                !!el.form && el.form === submit.form && el.form.method.toLowerCase() === 'post' &&
                new URL(el.form.action).origin === location.origin""",
                submit,
            ):
                raise BrowserRefused("BROWSER_CREDENTIAL_FORM_REFUSED")
            if name == "password" and not await self.elements[name].evaluate(
                "el => el.type === 'password'"
            ):
                raise BrowserRefused("BROWSER_CREDENTIAL_TARGET_CHANGED")
        if not await submit.evaluate(
            "el => (el.tagName === 'BUTTON' || el.tagName === 'INPUT') && el.type === 'submit' && !el.formTarget && (!el.formMethod || el.formMethod.toLowerCase() === 'post') && (!el.getAttribute('formaction') || new URL(el.formAction).origin === location.origin)"
        ):
            raise BrowserRefused("BROWSER_CREDENTIAL_FORM_REFUSED")

    async def fill_submit(
        self, lease: CredentialLease, *, check: Callable[[], Awaitable[None]]
    ) -> None:
        code = None
        try:
            if self.request.targets.otp is not None:
                if lease.totp_secret is None:
                    raise BrowserRefused("BROWSER_CREDENTIAL_OTP_UNAVAILABLE")
                code = totp(lease.totp_secret)
                self._otp_code = code
            for name, value in (
                ("username", lease.username),
                ("password", lease.password),
                ("otp", code),
            ):
                if value is None:
                    continue
                await check()
                await self.recheck()
                if not isinstance(value, bytearray) or not 1 <= len(value) <= 4096:
                    raise BrowserRefused("BROWSER_CREDENTIAL_PAYLOAD_REFUSED")
                await self.elements[name].fill(value.decode("utf-8"))
            await check()
            await self.recheck()
            if self.navigation_cleanup is None:
                raise BrowserRefused("BROWSER_SECRET_CLEANUP_UNCONFIRMED")
            await self.navigation_cleanup.arm(self.request)
            self.submitting = True
            await self.elements["submit"].click()
        finally:
            # Retain only the owned code buffer for exact echo checks across a
            # TOTP period boundary, then erase it during transaction cleanup.
            if code is not None and self._otp_code is not code:
                code[:] = b"\0" * len(code)

    async def clear_selected(self) -> None:
        if self.original_cleared:
            return
        if self.navigation_cleanup is not None and self.navigation_cleanup.receipt.is_set():
            self.original_cleared = True
            return
        for name, element in self.elements.items():
            if name != "submit":
                # No input/change event: don't trigger a second website effect.
                await element.evaluate("el => { el.value = ''; }")
                if not await element.evaluate("el => el.value.length === 0"):
                    raise BrowserRefused("BROWSER_SECRET_FIELDS_NOT_CLEARED")
        self.original_cleared = True

    async def reject_echo(self, lease: CredentialLease) -> None:
        from .playwright_secret_cleanup import require_verifiable_shadow_roots

        # Exact-value refusal is a disclosure guard, never a login classifier.
        # Live values and shadow trees are absent from light DOM serialization.
        # This does not attest pixel content or future script mutations.
        await require_verifiable_shadow_roots(
            self.navigation_cleanup.cdp if self.navigation_cleanup else None
        )
        values = [lease.password.decode("utf-8")]
        if self._otp_code is not None:
            values.append(self._otp_code.decode("ascii"))
        try:
            if self.navigation_cleanup is None or not await self.navigation_cleanup.safe_boolean(
                """values => {
                const documentText = document.documentElement;
                const texts = [documentText?.outerHTML || '', documentText?.textContent || '', location.href];
                try { texts.push(decodeURIComponent(location.href)); } catch {}
                const shadow = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot').get;
                const input = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get;
                const textarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').get;
                const select = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').get;
                const roots = [document];
                for (let index = 0; index < roots.length; index++) {
                  const root = roots[index];
                  if (root !== document) texts.push(root.innerHTML, root.textContent || '');
                  for (const el of root.querySelectorAll('*')) {
                    if (el instanceof HTMLInputElement) texts.push(input.call(el));
                    else if (el instanceof HTMLTextAreaElement) texts.push(textarea.call(el));
                    else if (el instanceof HTMLSelectElement) texts.push(select.call(el));
                    const nested = shadow.call(el);
                    if (nested) roots.push(nested);
                  }
                }
                return values.every(value => texts.every(text => !text.includes(value)));
            }""",
                values,
            ):
                raise BrowserRefused("BROWSER_SECRET_ECHO_REFUSED")
        finally:
            values.clear()

    async def clear(self) -> None:
        try:
            # Navigation cleanup first occurs at the intercepted Document POST,
            # after Chromium serializes it, before broker IO can navigate away.
            await self.clear_selected()
            await require_clear_inputs(
                self.page,
                cdp=self.navigation_cleanup.cdp if self.navigation_cleanup else None,
                frame_id=self.navigation_cleanup.frame_id if self.navigation_cleanup else None,
                private_entry=True,
            )
            self.cleared = True
        finally:
            if self._otp_code is not None:
                self._otp_code[:] = b"\0" * len(self._otp_code)
                self._otp_code = None
            await asyncio.gather(
                *(element.dispose() for element in self.elements.values()), return_exceptions=True
            )
            self.elements.clear()
            if self.navigation_cleanup is not None:
                await self.navigation_cleanup.close()

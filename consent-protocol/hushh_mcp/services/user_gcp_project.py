"""Naming and creating the project a person's pod will live in (BYOC onboarding).

The frontend asks one question -- "what should we call your cloud?" -- and this module
is everything behind it: a sensible suggestion, validation against Google's actual
project-id rules, an availability check, and creation.

THE THING THAT CANNOT BE PAPERED OVER
-------------------------------------
"Create the project for them" has two implementations and they are not equivalent:

* **Guided** -- hushh proposes the name and hands the person a one-click console link
  (or the exact `gcloud` line). *They* create it, in *their* organization, owning it
  from the first second. hushh needs no permission anywhere near their cloud.
* **Delegated** -- hushh creates it itself. This requires
  ``resourcemanager.projects.create`` on the person's organization or folder, which is
  an **org-level standing grant** -- categorically larger than the one-service-account
  binding the rest of BYOC rests on (see ``user_gcp_bootstrap``). It is a real option
  for an enterprise that wants it, and it is the wrong default for a consumer.

There is a third thing that looks like an answer and is not: hushh creating the project
inside *hushh's* organization and calling it the person's cloud. It would be hushh's
project, hushh's billing account, hushh's org policy, and hushh's to delete. "Own your
compute" would be false in the only sense that matters, so it is not offered.

So ``GUIDED`` is the default, ``DELEGATED`` is available when the person has explicitly
granted a parent, and **neither blocks the journey** -- a person who already has a
project just names it and skips creation entirely. That last case is the common one, and
the flow is built around it rather than treating it as an exception.

WHY THE SUGGESTION IS DETERMINISTIC
-----------------------------------
The suggested id is derived from the owner's ``hushh_id`` through a keyed digest, so it
is stable: reload the page, come back tomorrow, retry a failed creation -- same name.
A random suggestion would change under the user between seeing it and accepting it,
which is a bad thing to do to somebody naming infrastructure they are about to own.

The digest is keyed and truncated so the id carries no recoverable identifier. A project
id is visible in their console, in URLs, and in any support conversation; it should not
be a place where a HusshID can be read back out.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: How the project gets created. See the module docstring for why GUIDED is the default.
CREATION_GUIDED = "guided"
CREATION_DELEGATED = "delegated"

#: Google's rules for a project id, as enforced rather than as remembered:
#: 6-30 characters, lowercase letters / digits / hyphens, must start with a letter,
#: must not end with a hyphen.
_PROJECT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_MIN_LEN, _MAX_LEN = 6, 30

#: Substrings Google refuses outright. Checked so a person is told at type time rather
#: than by a creation failure after they have committed to the name.
_FORBIDDEN = ("google", "ssl", "undefined", "null")

#: The prefix a person will recognise in their own console a year from now.
_PREFIX = "hussh-one-"

#: Suffix alphabet: no vowels (so it cannot accidentally spell something), and no
#: characters that are misread aloud or in a support ticket -- 0/o, 1/l/i.
_SUFFIX_ALPHABET = "bcdfghjkmnpqrstvwxyz23456789"
_SUFFIX_LEN = 6


@dataclass(frozen=True)
class ProjectNameSuggestion:
    """What the UI shows in the field, and everything it needs to explain it."""

    project_id: str
    display_name: str
    editable: bool = True
    #: Why this name, in one sentence a person reads once and never again.
    rationale: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "projectId": self.project_id,
            "displayName": self.display_name,
            "editable": self.editable,
            "rationale": self.rationale,
        }


@dataclass(frozen=True)
class ProjectIdVerdict:
    """Is this a name Google will accept, and is it free?"""

    project_id: str
    valid: bool
    available: Optional[bool]
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "projectId": self.project_id,
            "valid": self.valid,
            # `None` means "could not determine", which is NOT the same as "taken" and
            # must not be rendered as a red X. See `check_project_id`.
            "available": self.available,
            "reason": self.reason,
        }


def _suffix_for(hushh_id: str) -> str:
    """A stable, non-identifying suffix. Keyed so the HusshID cannot be read back."""
    from hushh_mcp.config import APP_SIGNING_KEY  # noqa: PLC0415

    digest = hmac.new(
        str(APP_SIGNING_KEY or "").encode("utf-8"),
        f"byoc-project-id|{hushh_id}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    n = len(_SUFFIX_ALPHABET)
    return "".join(_SUFFIX_ALPHABET[b % n] for b in digest[:_SUFFIX_LEN])


def suggest_project_id(hushh_id: str, *, display_hint: str = "") -> ProjectNameSuggestion:
    """The name we put in the field, pre-filled and editable.

    ``display_hint`` (a first name, say) is used only for the human-readable DISPLAY
    name, never for the id. Display names are free-form and live only in the person's
    own console; ids end up in URLs, logs and support threads, so they stay
    non-identifying regardless of what we happen to know about the person.
    """
    project_id = f"{_PREFIX}{_suffix_for(hushh_id)}"
    friendly = str(display_hint or "").strip()
    display_name = f"{friendly}'s Agent One" if friendly else "🤫 Agent One"
    return ProjectNameSuggestion(
        project_id=project_id,
        display_name=display_name[:30],
        rationale=(
            "A name you will recognise in your own Google Cloud console. Change it to "
            "anything you like — it is your project, and this is only a suggestion."
        ),
    )


def validate_project_id(project_id: str) -> ProjectIdVerdict:
    """Google's rules, checked here so a person hears about a bad name while typing.

    Availability is deliberately NOT decided here: it needs a network call, and a
    validity check that silently did I/O would be surprising in a form-field validator.
    """
    pid = str(project_id or "").strip()
    if not pid:
        return ProjectIdVerdict(pid, False, None, "Give your project a name.")
    if len(pid) < _MIN_LEN or len(pid) > _MAX_LEN:
        return ProjectIdVerdict(
            pid, False, None, f"Use between {_MIN_LEN} and {_MAX_LEN} characters."
        )
    if not _PROJECT_ID_RE.match(pid):
        return ProjectIdVerdict(
            pid,
            False,
            None,
            "Use lowercase letters, numbers and hyphens. Start with a letter and do "
            "not end with a hyphen.",
        )
    for bad in _FORBIDDEN:
        if bad in pid:
            return ProjectIdVerdict(pid, False, None, f"Google does not allow “{bad}” in a project name.")
    return ProjectIdVerdict(pid, True, None, "Looks good.")


def check_project_id(
    project_id: str, *, token: str = "", session: Any = None
) -> ProjectIdVerdict:
    """Validity plus a best-effort availability probe.

    **The ambiguity is real and is reported rather than hidden.** Google has no public
    "is this id free" endpoint. Reading the project gives:

    * ``404`` -- nothing there; treat as available.
    * ``200`` -- exists and we can see it; taken.
    * ``403`` -- exists and we cannot see it, **or** the caller simply lacks permission
      to look. Those are different facts with one status code, so this returns
      ``available=None`` and says so, rather than showing a person a red X for a name
      that may be perfectly free.

    A deleted project's id is also unavailable for 30 days, which no probe can
    distinguish from taken. Creation is the only authority; this is a courtesy.
    """
    verdict = validate_project_id(project_id)
    if not verdict.valid:
        return verdict

    if session is None:
        import requests as session  # noqa: PLC0415

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    response = session.get(
        f"https://cloudresourcemanager.googleapis.com/v1/projects/{verdict.project_id}",
        headers=headers,
        timeout=30,
    )
    code = getattr(response, "status_code", 0)
    if code == 404:
        return ProjectIdVerdict(verdict.project_id, True, True, "That name is free.")
    if code == 200:
        return ProjectIdVerdict(
            verdict.project_id, True, False, "That name is already taken. Try another."
        )
    return ProjectIdVerdict(
        verdict.project_id,
        True,
        None,
        "We could not check this name from here. You will find out for certain when it "
        "is created.",
    )


def guided_creation_instructions(
    *, project_id: str, display_name: str, billing_account: str = ""
) -> dict[str, Any]:
    """Everything a person needs to create the project themselves, in their own org.

    This is the default path, and the one that keeps "own your compute" literally true:
    the project is theirs from creation, hushh holds nothing over it, and the only thing
    we ever receive is the name they chose plus the one-account grant the bootstrap asks
    for afterwards.
    """
    return {
        "mode": CREATION_GUIDED,
        "projectId": project_id,
        "displayName": display_name,
        "consoleUrl": (
            "https://console.cloud.google.com/projectcreate"
            f"?projectId={project_id}&projectName={display_name}"
        ),
        "cliCommand": f'gcloud projects create {project_id} --name="{display_name}"',
        "billingNote": (
            "Google requires a billing account on the project before anything can run in "
            "it. Link one in the console; a private agent costs roughly a quarter of a "
            "dollar a month in infrastructure."
            + (f" Suggested account: {billing_account}." if billing_account else "")
        ),
        "whatHushhGets": "nothing yet — only the name, until you authorize the next step",
    }


def create_project(
    *,
    project_id: str,
    display_name: str,
    parent_type: str,
    parent_id: str,
    token: str,
    session: Any = None,
) -> dict[str, Any]:
    """Delegated creation: hushh makes the project inside a parent the person named.

    Only reachable when the person has granted ``resourcemanager.projects.create`` on
    that organization or folder. That grant is org-level and larger than anything else
    BYOC asks for, so the caller is expected to have shown them what it means first —
    ``delegated_creation_disclosure`` is that text.

    Returns the operation result rather than polling to completion: project creation is
    asynchronous, and a caller that wants to wait should say so explicitly instead of
    having a form submit block on Google.
    """
    verdict = validate_project_id(project_id)
    if not verdict.valid:
        raise ValueError(verdict.reason)
    if parent_type not in ("organization", "folder"):
        raise ValueError("a project must be created under an organization or a folder")
    if not parent_id:
        raise ValueError(
            "delegated creation needs the parent the person authorized; it is never guessed"
        )

    if session is None:
        import requests as session  # noqa: PLC0415

    response = session.post(
        "https://cloudresourcemanager.googleapis.com/v1/projects",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "projectId": verdict.project_id,
            "name": display_name or verdict.project_id,
            "parent": {"type": parent_type, "id": parent_id},
            "labels": {"created-by": "hussh-one", "tenancy": "user-owned"},
        },
        timeout=120,
    )
    code = getattr(response, "status_code", 0)
    ok = code in (200, 201)
    logger.info(
        "byoc_project.create project=%s parent=%s/%s status=%s",
        verdict.project_id,
        parent_type,
        parent_id,
        code,
    )
    return {
        "mode": CREATION_DELEGATED,
        "projectId": verdict.project_id,
        "ok": ok,
        "status": code,
        "operation": response.json().get("name", "") if ok else "",
        "detail": "" if ok else getattr(response, "text", "")[:300],
        # Creating the project does not pay for it. Google refuses almost every API in
        # an unbilled project, so the next step is always billing -- said here so a
        # caller cannot report "created" as if the project were usable.
        "next": "link a billing account before the bootstrap can run",
    }


def delegated_creation_disclosure(*, parent_type: str, parent_id: str) -> dict[str, Any]:
    """What delegated creation actually costs the person, stated before they agree.

    Separate from the creation call on purpose: consent that is bundled into the action
    it authorizes is not consent, it is a checkbox.
    """
    return {
        "grant": "roles/resourcemanager.projectCreator",
        "on": f"{parent_type} {parent_id}",
        "meaning": (
            "hushh will be able to create projects in this "
            f"{parent_type} until you remove the grant — not only this one."
        ),
        "why_this_is_larger": (
            "Every other permission BYOC asks for is scoped to a single service account "
            "or a single resource. This one is not, which is why it is optional and why "
            "creating the project yourself is the default."
        ),
        "alternative": (
            "Create the project yourself from the link we give you. It takes about a "
            "minute and hushh never holds this permission."
        ),
        "revocation": f"Remove roles/resourcemanager.projectCreator on {parent_type} {parent_id}.",
    }


__all__ = [
    "CREATION_DELEGATED",
    "CREATION_GUIDED",
    "ProjectIdVerdict",
    "ProjectNameSuggestion",
    "check_project_id",
    "create_project",
    "delegated_creation_disclosure",
    "guided_creation_instructions",
    "suggest_project_id",
    "validate_project_id",
]

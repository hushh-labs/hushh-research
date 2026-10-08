"""Which specialist tab a private-agent chat turn was sent from.

The Email, Location, Information and Kai tabs used to post their questions to the
hub. For a person whose agent runs in their own cloud that is content reaching the
hub, so those tabs now send an ordinary turn to the person's agent with a closed
``specialistFocus`` word instead. The word only steers which specialist One reaches
for first; it grants nothing. Every tool keeps its own admission (mail read
admission, consent, connector state), and a focus never widens any of them.

Contract:

* **Closed set.** Only ``email``, ``location``, ``information`` and ``finance``.
  Anything else is refused at ingress, never coerced or dropped silently.
* **Per turn.** Ingress writes the key on every turn, empty when absent, so a focus
  never leaks into the next ordinary turn of the same conversation.
* **Words, not authority.** The instruction is fixed text chosen by the enum. No
  client text enters it.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

STATE_SPECIALIST_FOCUS = "hussh:specialist_focus"
FORWARDED_SPECIALIST_FOCUS = "specialistFocus"

_INSTRUCTIONS: Mapping[str, str] = {
    "email": (
        "The person sent this from the Email tab. Treat it as a question about their "
        "mailbox first: reach for ask_email_agent when mail read admission is enabled, "
        "and relay its connect or reconnect state as it reports it."
    ),
    "location": (
        "The person sent this from the Location tab. Treat it as a question about "
        "places, sharing, circles or check-ins first: reach for ask_location_agent."
    ),
    "information": (
        "The person sent this from the Information tab. Treat it as a question about "
        "their marketplace profile and the information they publish first: reach for "
        "ask_memory_agent."
    ),
    "finance": (
        "The person sent this from Kai. Treat it as a finance question first: reach "
        "for the Finance specialist."
    ),
}

SPECIALIST_FOCI: frozenset[str] = frozenset(_INSTRUCTIONS)


class SpecialistFocusInvalid(ValueError):
    """The client named a focus outside the closed set."""


def admit_specialist_focus(forwarded: Mapping[str, Any]) -> str:
    """The admitted focus word, ``""`` when absent. Raises on anything else."""
    value = forwarded.get(FORWARDED_SPECIALIST_FOCUS)
    if value is None or value == "":
        return ""
    if not isinstance(value, str) or value not in SPECIALIST_FOCI:
        raise SpecialistFocusInvalid("Specialist focus is not recognised.")
    return value


def specialist_focus_instruction(state_getter: Callable[..., Any] | None) -> str:
    """Fixed guidance for the root instruction, or ``""`` for an ordinary turn."""
    if not callable(state_getter):
        return ""
    text = _INSTRUCTIONS.get(str(state_getter(STATE_SPECIALIST_FOCUS) or ""))
    if text is None:
        return ""
    return (
        "\n\nSPECIALIST FOCUS: "
        + text
        + " This focus only orders your first choice. It grants no access; every tool "
        "keeps its own admission, and if the question is about something else, answer that."
    )


__all__ = [
    "FORWARDED_SPECIALIST_FOCUS",
    "SPECIALIST_FOCI",
    "STATE_SPECIALIST_FOCUS",
    "SpecialistFocusInvalid",
    "admit_specialist_focus",
    "specialist_focus_instruction",
]

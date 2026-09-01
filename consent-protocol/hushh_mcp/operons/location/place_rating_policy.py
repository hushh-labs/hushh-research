"""Pure policy for rating a place you checked in at.

No I/O, no database, no clock. Every decision here is a function of its
arguments, so the rules that decide what may be published can be read, tested
and argued about without standing up a service.

The three that matter:

* which places may never carry a public average at all;
* how few raters is too few to publish one;
* how a published count is coarsened so that watching it cannot recover an
  individual rating.
"""

from __future__ import annotations

import unicodedata
from typing import Any
from urllib.parse import quote

PLACE_RATING_CAPABILITY_SCOPES = [
    "cap.location.place_rating.publish",
    "cap.location.place_rating.discover",
    "cap.location.place_rating.revoke",
]

MIN_PLACE_RATING = 1
MAX_PLACE_RATING = 5

PLACE_ID_MAX_LENGTH = 300
PLACE_LABEL_MAX_LENGTH = 300

# Below this many distinct raters a place has no public average.
#
# At one rater the "average" IS that person's rating, and at three, anyone who
# knows one rater -- you were both on the same roster an hour ago -- learns a
# great deal about the other two. Five is the smallest number at which a
# published mean stops being a thin disguise for a single opinion.
PLACE_RATING_PUBLICATION_MIN_COUNT = 5

# Counts are published in buckets, never exactly.
#
# An observer polling an exact (count, average) pair recovers every new rating
# by subtraction: (4, 4.25) -> (5, 4.40) says the fifth rating was a 5, to the
# resolution of the poll. Rounding the average does not fix it; only refusing
# to publish the exact count does. This is the classic aggregate-disclosure
# attack and it works at every n, not only small ones.
_COUNT_BUCKETS: tuple[tuple[int, str], ...] = (
    (500, "500+"),
    (100, "100+"),
    (50, "50+"),
    (10, "10+"),
    (PLACE_RATING_PUBLICATION_MIN_COUNT, f"{PLACE_RATING_PUBLICATION_MIN_COUNT}+"),
)

# Google's own place type vocabulary, for the categories where a public star
# average is not a product feature but a disclosure.
#
# A public average is a statement that some number of Hushh members were here.
# For a cafe that is trivia. For a clinic it is health data; for a shelter or a
# de-addiction centre it can be a physical-safety outcome; for a place of
# worship or a lawyer's office it is a belief or a legal jeopardy that the
# person never chose to publish.
#
# These are EXCLUDED, not warned about. Nobody chooses a hospital by Hushh's
# star average, so the product cost is about zero and the worst harm this
# feature could do disappears with it. The author still gets their own private
# rating and their own history -- only the shared average is withheld.
SENSITIVE_PLACE_TYPES: frozenset[str] = frozenset(
    {
        # health
        "hospital",
        "medical_clinic",
        "doctor",
        "dentist",
        "pharmacy",
        "drugstore",
        "physiotherapist",
        "psychologist",
        "psychiatrist",
        "wellness_center",
        "medical_lab",
        "chiropractor",
        # worship
        "church",
        "hindu_temple",
        "mosque",
        "synagogue",
        "place_of_worship",
        # legal and civic jeopardy
        "lawyer",
        "courthouse",
        "police",
        "embassy",
        "local_government_office",
        # end of life
        "funeral_home",
        "cemetery",
        "cremation",
        # refuge and recovery
        "shelter",
        "homeless_shelter",
        "womens_shelter",
        "rehabilitation_center",
        "addiction_treatment_center",
    }
)


def normalize_rating(value: Any) -> int:
    """Return a 1-5 star rating, or raise ``ValueError``.

    A bool is rejected before the int check on purpose: ``isinstance(True, int)``
    is ``True`` in Python, so ``True`` would otherwise arrive here as a
    perfectly valid one-star rating.
    """
    if isinstance(value, bool):
        raise ValueError("rating must be a whole number from 1 to 5")
    if not isinstance(value, int):
        raise ValueError("rating must be a whole number from 1 to 5")
    if value < MIN_PLACE_RATING or value > MAX_PLACE_RATING:
        raise ValueError("rating must be a whole number from 1 to 5")
    return value


def normalize_place_id(value: Any) -> str:
    place_id = str(value or "").strip()
    if not place_id or len(place_id) > PLACE_ID_MAX_LENGTH:
        raise ValueError("place id is required")
    return place_id


def normalize_place_label(value: Any) -> str:
    """Collapse a provider place label to something storable.

    NFC, not NFD, and no diacritic stripping of any kind. A place label here is
    routinely Devanagari -- "तेलियरगंज", "नीलेश" -- and a matra is part of the
    letter, not decoration on it. `people-search.ts` documents the same trap in
    the other direction; the rule is the one in safe-changes R20.
    """
    label = unicodedata.normalize("NFC", str(value or ""))
    label = "".join(char for char in label if unicodedata.category(char) not in {"Cc", "Cf"})
    label = " ".join(label.split())
    if not label:
        raise ValueError("place label is required")
    return label[:PLACE_LABEL_MAX_LENGTH]


def is_aggregatable_category(primary_type: Any) -> bool:
    """Whether a place of this Google primary type may carry a public average."""
    normalized = str(primary_type or "").strip().lower()
    if not normalized:
        # An unknown type is treated as aggregatable. The denylist is the
        # exception, and refusing everything unlabelled would silently delete
        # the feature for every place Google does not classify.
        return True
    return normalized not in SENSITIVE_PLACE_TYPES


def bucket_rating_count(count: Any) -> str | None:
    """Coarsen a rater count for publication, or ``None`` below the threshold."""
    try:
        total = int(count)
    except (TypeError, ValueError):
        return None
    if total < PLACE_RATING_PUBLICATION_MIN_COUNT:
        return None
    for floor, label in _COUNT_BUCKETS:
        if total >= floor:
            return label
    return None


def publishable_average(*, rating_count: Any, rating_sum: Any) -> float | None:
    """Return the one-decimal public average, or ``None`` if it may not be shown."""
    try:
        count = int(rating_count)
        total = int(rating_sum)
    except (TypeError, ValueError):
        return None
    if count < PLACE_RATING_PUBLICATION_MIN_COUNT or count <= 0:
        return None
    if total <= 0:
        return None
    return round(total / count, 1)


def google_write_review_url(place_id: Any) -> str | None:
    """Build the deep link into Google's own review composer.

    Google has never shipped a write API for consumer reviews -- the Places API
    is read-only on them and the Business Profile API only lets an owner reply
    on their own listing. This URL is the entire sanctioned integration: it
    opens Google's composer, where the person types and submits under their own
    Google account. Nothing can be prefilled.

    The query key is lowercase ``placeid``. Camel-casing it silently yields
    Google's generic search page instead of the composer, which is exactly the
    kind of thing that gets "tidied" in review -- hence the test.
    """
    try:
        normalized = normalize_place_id(place_id)
    except ValueError:
        return None
    return f"https://search.google.com/local/writereview?placeid={quote(normalized, safe='')}"

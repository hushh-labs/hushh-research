"""The strict rules the nearby-place chips are supposed to follow.

Reported from Prayagraj, with a screenshot: tapping "Hotels" in the check-in
drawer listed a lounge, a construction firm and two lodges. The question that
came with it -- do we have strict rules and definitions for every category? --
is what these tests answer, together with the harder half of the same brief: no
place may be silently skipped.

Two properties carry almost all of the weight:

* every Google type lands in exactly one chip, so no place is unreachable and
  none is filed under two categories that disagree;
* `place_categories` can never return an empty list, so "nothing is skipped" is
  a property of the function rather than a hope about the data.

The rest are the specific rows from the report, pinned so they cannot come back.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import place_taxonomy as taxonomy


def test_every_google_type_lands_in_exactly_one_chip() -> None:
    """The partition. This is the "nothing is missed" guarantee.

    A type in no chip is a venue that shows under "All" and then vanishes behind
    the first tap -- which is how temples, mosques, police stations, cinemas and
    stadiums were invisible before this. A type in TWO chips is the other half
    of the reported defect: a place filed under a category somebody has decided
    it does not belong to.
    """

    covered: set[str] = set()
    for chip, place_types in taxonomy.CHIP_TYPES.items():
        for place_type in place_types:
            assert place_type not in covered, (
                f"{place_type!r} is claimed by more than one chip; {chip!r} is the second"
            )
            covered.add(place_type)

    # Geographical areas are a country or a postcode, not somewhere a person can
    # stand. `google_maps_service` rejects them before classification, so they
    # are the one family deliberately outside the partition.
    expected = taxonomy.TABLE_A_TYPES - set(taxonomy.FAMILY_GEOGRAPHIC)
    assert covered == expected


def test_no_place_is_ever_left_without_a_chip() -> None:
    # The three shapes Google actually sends for a venue it knows little about.
    # Each used to produce `[]`, which the client's filter reads as "belongs to
    # no chip" and drops from every list but "All".
    for place_types in ([], ["establishment", "point_of_interest"], ["zzz_not_a_real_type"]):
        assert taxonomy.place_categories(place_types) == ["other"]


def test_a_lounge_is_not_a_hotel() -> None:
    # The reported row. Google tags some venues with both a precise type and a
    # vague parent; when every match voted equally, "Mishra Lounge" was a hotel.
    assert taxonomy.place_categories(["lounge_bar", "lodging", "establishment"]) == ["food_drink"]


def test_a_precise_type_always_beats_a_vague_one() -> None:
    # The general rule the case above is one instance of.
    assert taxonomy.place_categories(["pharmacy", "store"]) == ["health"]
    assert taxonomy.place_categories(["hindu_temple", "tourist_attraction"]) == [
        "outdoors_landmarks",
        "worship",
    ]


def test_a_place_google_knows_only_as_lodging_is_still_somewhere_to_stay() -> None:
    # Deliberate, and the reason `lodging` is not simply dropped: in India a
    # "Residency" or a "lodge" IS a place you pay to sleep in, and Google often
    # has no more precise type for one. Two of the five reported rows were
    # correct; only their subtitle was confusing.
    assert taxonomy.place_categories(["lodging"]) == ["hotels_stays"]
    assert taxonomy.place_categories(["guest_house", "lodging"]) == ["hotels_stays"]


def test_hotels_means_somewhere_you_can_sleep() -> None:
    hotels = set(taxonomy.CHIP_TYPES["hotels_stays"])
    for stay in ("hotel", "motel", "hostel", "inn", "guest_house", "resort_hotel"):
        assert stay in hotels
    # A campsite is somewhere you spend time, not a room for the night, and a
    # mobile-home park is somewhere people live.
    for not_a_room in ("campground", "camping_cabin", "rv_park", "mobile_home_park"):
        assert not_a_room not in hotels
        assert taxonomy.place_categories([not_a_room]) != ["hotels_stays"]


def test_a_contractor_is_not_a_hotel() -> None:
    # "Vaishali Infratech" carried the subtitle "Hotel". Where Google gives us a
    # second, truer type we use it; `general_contractor` is Table B, so it is
    # read from the response and never requested.
    assert taxonomy.place_categories(["general_contractor", "establishment"]) == [
        "shopping_services"
    ]


def test_worship_and_civic_are_reachable_at_all() -> None:
    # Neither had a chip before, so every one of these was invisible behind the
    # first tap.
    for place_type in taxonomy.FAMILY_WORSHIP:
        assert taxonomy.place_categories([place_type]) == ["worship"]
    for place_type in taxonomy.FAMILY_GOVERNMENT:
        assert taxonomy.place_categories([place_type]) == ["civic"]


def test_chips_are_returned_in_a_stable_declared_order() -> None:
    # The client renders chips in this order and the drawer shows the first
    # match, so two places in the same pair of chips must read the same way.
    assert taxonomy.place_categories(["hindu_temple", "museum"]) == [
        "outdoors_landmarks",
        "worship",
    ]
    assert taxonomy.place_categories(["museum", "hindu_temple"]) == [
        "outdoors_landmarks",
        "worship",
    ]


def test_a_type_claimed_twice_fails_at_import_rather_than_in_the_drawer() -> None:
    original = taxonomy.CHIP_TYPES.copy()
    try:
        taxonomy.CHIP_TYPES["worship"] = (*taxonomy.CHIP_TYPES["worship"], "hotel")
        with pytest.raises(ValueError, match="exactly one chip"):
            taxonomy._build_chip_index()
    finally:
        taxonomy.CHIP_TYPES.clear()
        taxonomy.CHIP_TYPES.update(original)


def test_the_subtitle_never_reads_lodging() -> None:
    # The word that made two correct rows look wrong.
    assert taxonomy.display_label("lodging", "Lodging") == "Place to stay"
    # Google's own word everywhere it is not confusing.
    assert taxonomy.display_label("hotel", "Hotel") == "Hotel"
    assert taxonomy.display_label("hindu_temple", "Hindu temple") == "Hindu temple"
    # And never blank: a row with no supporting line reads as still loading.
    assert taxonomy.display_label(None, None) == "Place"
    assert taxonomy.display_label("some_new_type", None) == "Some New Type"

"""One statement of what each nearby-place category MEANS.

Reported, with a screenshot, from Prayagraj: tapping the check-in drawer's
"Hotels" chip listed a lounge, a construction firm and two lodges. The question
that came with it is the one this module exists to answer -- "sabhi
categorization ke liye strict rules / definition hain hamare paas?" -- together
with a hard requirement that no place may be silently skipped.

WHAT WAS ACTUALLY WRONG

Not what it looked like. The drawer's row subtitle is Google's own
``primaryTypeDisplayName``, so a row reading "Lodging" proves Google itself
reports ``lodging`` as that place's primary type. Two of the five rows were
therefore correct and only worded badly -- in India a "Residency" and a "lodge"
ARE places you pay to sleep in. What was genuinely wrong was three things:

1. A place carrying BOTH a precise type and a vague one was filed under both.
   A lounge that Google also tags ``lodging`` appeared under Hotels, because
   every matching type voted equally. See `place_categories`.
2. The table was 52 hand-picked types out of Table A's ~500. Anything outside
   it -- a temple, a mosque, a police station, a cinema, a stadium -- matched no
   category at all and vanished the moment any chip was tapped. In a pilgrimage
   city that is a bigger hole than the lounge.
3. "Hotels" contained campsites and mobile-home parks, which are not a room for
   the night.

THE RULES, IN ONE PLACE

* Every Table A type Google can return belongs to EXACTLY ONE chip. The
  partition is checked at import time (`_build_chip_index` raises on a type
  claimed twice) and asserted exhaustively by the tests.
* A place is classified by WHAT IT IS, never by which request surfaced it.
* A precise type always beats a vague one. `_VAGUE_TYPES` are the umbrella
  buckets Google hangs whole families off; they decide a place's category only
  when nothing precise is known about it.
* A place that matches nothing is `other`, which is a real, visible chip. This
  function cannot return an empty list, which is what makes "nothing is
  skipped" a property rather than a hope.

Pure: no I/O, no clock, no provider call. `google_maps_service` owns the
requests; this module owns the meaning.

Table A and Table B were transcribed verbatim from
https://developers.google.com/maps/documentation/places/web-service/place-types
on 2026-08-31. Regenerate from that page when Google adds types; the
exhaustiveness test fails loudly rather than letting a new type go missing.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Table A, under Google's own category headings.
#
# These are the REQUESTABLE, RETURNABLE types. Grouped exactly as the docs group
# them so a future regeneration is a diff against one page rather than a
# judgement call.
# ---------------------------------------------------------------------------

FAMILY_AUTOMOTIVE = (
    "car_dealer",
    "car_rental",
    "car_repair",
    "car_wash",
    "ebike_charging_station",
    "electric_vehicle_charging_station",
    "gas_station",
    "parking",
    "parking_garage",
    "parking_lot",
    "rest_stop",
    "tire_shop",
    "truck_dealer",
)

FAMILY_BUSINESS = (
    "business_center",
    "corporate_office",
    "coworking_space",
    "farm",
    "manufacturer",
    "ranch",
    "supplier",
    "television_studio",
)

FAMILY_CULTURE = (
    "art_gallery",
    "art_museum",
    "art_studio",
    "auditorium",
    "castle",
    "cultural_landmark",
    "fountain",
    "historical_place",
    "history_museum",
    "monument",
    "museum",
    "performing_arts_theater",
    "sculpture",
)

FAMILY_EDUCATION = (
    "academic_department",
    "educational_institution",
    "library",
    "preschool",
    "primary_school",
    "research_institute",
    "school",
    "secondary_school",
    "university",
)

FAMILY_ENTERTAINMENT = (
    "adventure_sports_center",
    "amphitheatre",
    "amusement_center",
    "amusement_park",
    "aquarium",
    "banquet_hall",
    "barbecue_area",
    "botanical_garden",
    "bowling_alley",
    "casino",
    "childrens_camp",
    "city_park",
    "comedy_club",
    "community_center",
    "concert_hall",
    "convention_center",
    "cultural_center",
    "cycling_park",
    "dance_hall",
    "dog_park",
    "event_venue",
    "ferris_wheel",
    "garden",
    "go_karting_venue",
    "hiking_area",
    "historical_landmark",
    "indoor_playground",
    "internet_cafe",
    "karaoke",
    "live_music_venue",
    "marina",
    "miniature_golf_course",
    "movie_rental",
    "movie_theater",
    "national_park",
    "night_club",
    "observation_deck",
    "off_roading_area",
    "opera_house",
    "paintball_center",
    "park",
    "philharmonic_hall",
    "picnic_ground",
    "planetarium",
    "plaza",
    "roller_coaster",
    "skateboard_park",
    "state_park",
    "tourist_attraction",
    "video_arcade",
    "vineyard",
    "visitor_center",
    "water_park",
    "wedding_venue",
    "wildlife_park",
    "wildlife_refuge",
    "zoo",
)

FAMILY_FACILITIES = ("public_bath", "public_bathroom", "stable")

FAMILY_FINANCE = ("accounting", "atm", "bank")

FAMILY_FOOD_DRINK = (
    "acai_shop",
    "afghani_restaurant",
    "african_restaurant",
    "american_restaurant",
    "argentinian_restaurant",
    "asian_fusion_restaurant",
    "asian_restaurant",
    "australian_restaurant",
    "austrian_restaurant",
    "bagel_shop",
    "bakery",
    "bangladeshi_restaurant",
    "bar",
    "bar_and_grill",
    "barbecue_restaurant",
    "basque_restaurant",
    "bavarian_restaurant",
    "beer_garden",
    "belgian_restaurant",
    "bistro",
    "brazilian_restaurant",
    "breakfast_restaurant",
    "brewery",
    "brewpub",
    "british_restaurant",
    "brunch_restaurant",
    "buffet_restaurant",
    "burmese_restaurant",
    "burrito_restaurant",
    "cafe",
    "cafeteria",
    "cajun_restaurant",
    "cake_shop",
    "californian_restaurant",
    "cambodian_restaurant",
    "candy_store",
    "cantonese_restaurant",
    "caribbean_restaurant",
    "cat_cafe",
    "chicken_restaurant",
    "chicken_wings_restaurant",
    "chilean_restaurant",
    "chinese_noodle_restaurant",
    "chinese_restaurant",
    "chocolate_factory",
    "chocolate_shop",
    "cocktail_bar",
    "coffee_roastery",
    "coffee_shop",
    "coffee_stand",
    "colombian_restaurant",
    "confectionery",
    "croatian_restaurant",
    "cuban_restaurant",
    "czech_restaurant",
    "danish_restaurant",
    "deli",
    "dessert_restaurant",
    "dessert_shop",
    "dim_sum_restaurant",
    "diner",
    "dog_cafe",
    "donut_shop",
    "dumpling_restaurant",
    "dutch_restaurant",
    "eastern_european_restaurant",
    "ethiopian_restaurant",
    "european_restaurant",
    "falafel_restaurant",
    "family_restaurant",
    "fast_food_restaurant",
    "filipino_restaurant",
    "fine_dining_restaurant",
    "fish_and_chips_restaurant",
    "fondue_restaurant",
    "food_court",
    "french_restaurant",
    "fusion_restaurant",
    "gastropub",
    "german_restaurant",
    "greek_restaurant",
    "gyro_restaurant",
    "halal_restaurant",
    "hamburger_restaurant",
    "hawaiian_restaurant",
    "hookah_bar",
    "hot_dog_restaurant",
    "hot_dog_stand",
    "hot_pot_restaurant",
    "hungarian_restaurant",
    "ice_cream_shop",
    "indian_restaurant",
    "indonesian_restaurant",
    "irish_pub",
    "irish_restaurant",
    "israeli_restaurant",
    "italian_restaurant",
    "japanese_curry_restaurant",
    "japanese_izakaya_restaurant",
    "japanese_restaurant",
    "juice_shop",
    "kebab_shop",
    "korean_barbecue_restaurant",
    "korean_restaurant",
    "latin_american_restaurant",
    "lebanese_restaurant",
    "lounge_bar",
    "malaysian_restaurant",
    "meal_delivery",
    "meal_takeaway",
    "mediterranean_restaurant",
    "mexican_restaurant",
    "middle_eastern_restaurant",
    "mongolian_barbecue_restaurant",
    "moroccan_restaurant",
    "noodle_shop",
    "north_indian_restaurant",
    "oyster_bar_restaurant",
    "pakistani_restaurant",
    "pastry_shop",
    "persian_restaurant",
    "peruvian_restaurant",
    "pizza_delivery",
    "pizza_restaurant",
    "polish_restaurant",
    "portuguese_restaurant",
    "pub",
    "ramen_restaurant",
    "restaurant",
    "romanian_restaurant",
    "russian_restaurant",
    "salad_shop",
    "sandwich_shop",
    "scandinavian_restaurant",
    "seafood_restaurant",
    "shawarma_restaurant",
    "snack_bar",
    "soul_food_restaurant",
    "soup_restaurant",
    "south_american_restaurant",
    "south_indian_restaurant",
    "southwestern_us_restaurant",
    "spanish_restaurant",
    "sports_bar",
    "sri_lankan_restaurant",
    "steak_house",
    "sushi_restaurant",
    "swiss_restaurant",
    "taco_restaurant",
    "taiwanese_restaurant",
    "tapas_restaurant",
    "tea_house",
    "tex_mex_restaurant",
    "thai_restaurant",
    "tibetan_restaurant",
    "tonkatsu_restaurant",
    "turkish_restaurant",
    "ukrainian_restaurant",
    "vegan_restaurant",
    "vegetarian_restaurant",
    "vietnamese_restaurant",
    "western_restaurant",
    "wine_bar",
    "winery",
    "yakiniku_restaurant",
    "yakitori_restaurant",
)

# Not a chip. A country or a postcode is not somewhere you stand, and
# `google_maps_service` rejects these before classification ever runs. Kept here
# so the exhaustiveness test can subtract them explicitly rather than by
# omission.
FAMILY_GEOGRAPHIC = (
    "administrative_area_level_1",
    "administrative_area_level_2",
    "country",
    "locality",
    "postal_code",
    "school_district",
)

FAMILY_GOVERNMENT = (
    "city_hall",
    "courthouse",
    "embassy",
    "fire_station",
    "government_office",
    "local_government_office",
    "neighborhood_police_station",
    "police",
    "post_office",
)

FAMILY_HEALTH = (
    "chiropractor",
    "dental_clinic",
    "dentist",
    "doctor",
    "drugstore",
    "general_hospital",
    "hospital",
    "massage",
    "massage_spa",
    "medical_center",
    "medical_clinic",
    "medical_lab",
    "pharmacy",
    "physiotherapist",
    "sauna",
    "skin_care_clinic",
    "spa",
    "tanning_studio",
    "wellness_center",
    "yoga_studio",
)

FAMILY_HOUSING = (
    "apartment_building",
    "apartment_complex",
    "condominium_complex",
    "housing_complex",
)

FAMILY_LODGING = (
    "bed_and_breakfast",
    "budget_japanese_inn",
    "campground",
    "camping_cabin",
    "cottage",
    "extended_stay_hotel",
    "farmstay",
    "guest_house",
    "hostel",
    "hotel",
    "inn",
    "japanese_inn",
    "lodging",
    "mobile_home_park",
    "motel",
    "private_guest_room",
    "resort_hotel",
    "rv_park",
)

FAMILY_NATURAL = (
    "beach",
    "island",
    "lake",
    "mountain_peak",
    "nature_preserve",
    "river",
    "scenic_spot",
    "woods",
)

FAMILY_WORSHIP = (
    "buddhist_temple",
    "church",
    "hindu_temple",
    "mosque",
    "shinto_shrine",
    "synagogue",
)

FAMILY_SERVICES = (
    "aircraft_rental_service",
    "association_or_organization",
    "astrologer",
    "barber_shop",
    "beautician",
    "beauty_salon",
    "body_art_service",
    "catering_service",
    "cemetery",
    "chauffeur_service",
    "child_care_agency",
    "consultant",
    "courier_service",
    "electrician",
    "employment_agency",
    "florist",
    "food_delivery",
    "foot_care",
    "funeral_home",
    "hair_care",
    "hair_salon",
    "insurance_agency",
    "laundry",
    "lawyer",
    "locksmith",
    "makeup_artist",
    "marketing_consultant",
    "moving_company",
    "nail_salon",
    "non_profit_organization",
    "painter",
    "pet_boarding_service",
    "pet_care",
    "plumber",
    "psychic",
    "real_estate_agency",
    "roofing_contractor",
    "service",
    "shipping_service",
    "storage",
    "summer_camp_organizer",
    "tailor",
    "telecommunications_service_provider",
    "tour_agency",
    "tourist_information_center",
    "travel_agency",
    "veterinary_care",
)

FAMILY_SHOPPING = (
    "asian_grocery_store",
    "auto_parts_store",
    "bicycle_store",
    "book_store",
    "building_materials_store",
    "butcher_shop",
    "cell_phone_store",
    "clothing_store",
    "convenience_store",
    "cosmetics_store",
    "department_store",
    "discount_store",
    "discount_supermarket",
    "electronics_store",
    "farmers_market",
    "flea_market",
    "food_store",
    "furniture_store",
    "garden_center",
    "general_store",
    "gift_shop",
    "grocery_store",
    "hardware_store",
    "health_food_store",
    "home_goods_store",
    "home_improvement_store",
    "hypermarket",
    "jewelry_store",
    "liquor_store",
    "market",
    "pet_store",
    "shoe_store",
    "shopping_mall",
    "sporting_goods_store",
    "sportswear_store",
    "store",
    "supermarket",
    "tea_store",
    "thrift_store",
    "toy_store",
    "warehouse_store",
    "wholesaler",
    "womens_clothing_store",
)

FAMILY_SPORTS = (
    "arena",
    "athletic_field",
    "fishing_charter",
    "fishing_pier",
    "fishing_pond",
    "fitness_center",
    "golf_course",
    "gym",
    "ice_skating_rink",
    "indoor_golf_course",
    "playground",
    "race_course",
    "ski_resort",
    "sports_activity_location",
    "sports_club",
    "sports_coaching",
    "sports_complex",
    "sports_school",
    "stadium",
    "swimming_pool",
    "tennis_court",
)

FAMILY_TRANSPORT = (
    "airport",
    "airstrip",
    "bike_sharing_station",
    "bridge",
    "bus_station",
    "bus_stop",
    "ferry_service",
    "ferry_terminal",
    "heliport",
    "international_airport",
    "light_rail_station",
    "park_and_ride",
    "subway_station",
    "taxi_service",
    "taxi_stand",
    "toll_station",
    "train_station",
    "train_ticket_office",
    "tram_stop",
    "transit_depot",
    "transit_station",
    "transit_stop",
    "transportation_service",
    "truck_stop",
)

#: Every Table A type, for the exhaustiveness check.
TABLE_A_TYPES: frozenset[str] = frozenset(
    (
        *FAMILY_AUTOMOTIVE,
        *FAMILY_BUSINESS,
        *FAMILY_CULTURE,
        *FAMILY_EDUCATION,
        *FAMILY_ENTERTAINMENT,
        *FAMILY_FACILITIES,
        *FAMILY_FINANCE,
        *FAMILY_FOOD_DRINK,
        *FAMILY_GEOGRAPHIC,
        *FAMILY_GOVERNMENT,
        *FAMILY_HEALTH,
        *FAMILY_HOUSING,
        *FAMILY_LODGING,
        *FAMILY_NATURAL,
        *FAMILY_WORSHIP,
        *FAMILY_SERVICES,
        *FAMILY_SHOPPING,
        *FAMILY_SPORTS,
        *FAMILY_TRANSPORT,
    )
)


# ---------------------------------------------------------------------------
# The chips
# ---------------------------------------------------------------------------

#: Somewhere you can pay to sleep for the night.
#:
#: The Lodging family minus the four that are not a room: a campsite, a camping
#: cabin and an RV park are leisure, and a mobile-home park is somewhere people
#: live. `lodging` itself stays -- it is Google's word for a small guest house or
#: lodge, which genuinely is a place to stay, and dropping it would hide most of
#: India's budget accommodation.
_CHIP_HOTELS = tuple(
    place_type
    for place_type in FAMILY_LODGING
    if place_type not in {"campground", "camping_cabin", "rv_park", "mobile_home_park"}
)

#: Somewhere you go to spend time rather than to transact.
_CHIP_LEISURE = (
    *FAMILY_ENTERTAINMENT,
    *FAMILY_CULTURE,
    *FAMILY_NATURAL,
    *FAMILY_SPORTS,
    "campground",
    "camping_cabin",
    "rv_park",
)

#: A real venue that is none of the above -- offices, homes, farms, industry,
#: public facilities -- plus every venue Google names but does not describe.
_CHIP_OTHER = (
    *FAMILY_HOUSING,
    *FAMILY_BUSINESS,
    *FAMILY_FACILITIES,
    "mobile_home_park",
)

#: Which chip owns which Google type. Exhaustive over Table A minus the
#: geographic family, which is rejected before classification.
#:
#: Insertion order is the order chips render, and `place_categories` returns in
#: this order, so a place in two chips reads the same way everywhere.
CHIP_TYPES: dict[str, tuple[str, ...]] = {
    "food_drink": FAMILY_FOOD_DRINK,
    "health": FAMILY_HEALTH,
    "shopping_services": (
        *FAMILY_SHOPPING,
        *FAMILY_SERVICES,
        *FAMILY_FINANCE,
        *FAMILY_AUTOMOTIVE,
    ),
    "hotels_stays": _CHIP_HOTELS,
    "education": FAMILY_EDUCATION,
    "outdoors_landmarks": _CHIP_LEISURE,
    "transit": FAMILY_TRANSPORT,
    "worship": FAMILY_WORSHIP,
    "civic": FAMILY_GOVERNMENT,
    "other": _CHIP_OTHER,
}

#: The chip a place lands in when nothing else claims it. A real chip, not a
#: silent drop -- this is what makes "no place is skipped" true.
FALLBACK_CHIP = "other"

#: Table B is response-only ("Values from Table B may NOT be used as part of a
#: request"), but two of its members carry real classification signal and are
#: worth reading off a place that has nothing better.
TABLE_B_CHIPS: dict[str, str] = {
    "general_contractor": "shopping_services",
    "place_of_worship": "worship",
}

#: Umbrella types Google hangs whole families off. They describe a place only
#: when nothing precise is known about it.
#:
#: This is the rule that stops a lounge appearing under Hotels. Google tags some
#: venues with BOTH a precise type and a vague parent -- `lounge_bar` AND
#: `lodging` -- and when every match voted equally the place was filed under
#: both, so it turned up under a chip it plainly does not belong to. A precise
#: type now wins outright.
VAGUE_TYPES: frozenset[str] = frozenset(
    {
        "establishment",
        "point_of_interest",
        "food",
        "health",
        "finance",
        "landmark",
        "natural_feature",
        "lodging",
        "store",
        "service",
        "school",
        "educational_institution",
        "doctor",
        "transit_station",
        "sports_activity_location",
        "government_office",
        "association_or_organization",
    }
)


def _build_chip_index() -> dict[str, str]:
    """Reverse `CHIP_TYPES` into one chip per Google type.

    Raises at import time when two chips claim the same type. The partition is
    the whole contract of this module -- a type in two chips means a place shows
    under a category somebody has decided it does not belong to, which is the
    defect this module was written for.
    """

    index: dict[str, str] = {}
    for chip, place_types in CHIP_TYPES.items():
        for place_type in place_types:
            existing = index.get(place_type)
            if existing is not None and existing != chip:
                raise ValueError(
                    f"Place type {place_type!r} is claimed by both {existing!r} and {chip!r}. "
                    "Every type belongs to exactly one chip."
                )
            index[place_type] = chip
    return index


CHIP_BY_PLACE_TYPE: dict[str, str] = _build_chip_index()


def place_categories(place_types: list[str] | tuple[str, ...]) -> list[str]:
    """The chips a place belongs to, in chip order. Never empty.

    Precise beats vague: a venue reported as both `lounge_bar` and `lodging` is
    food and drink, not a hotel. Only when a place has nothing precise does an
    umbrella type decide it, which is how a small guest house Google knows only
    as `lodging` still reaches the Hotels chip.

    A place nothing claims is `other`, so every row the drawer shows is
    reachable from some chip.
    """

    precise: set[str] = set()
    vague: set[str] = set()
    for place_type in place_types:
        chip = CHIP_BY_PLACE_TYPE.get(place_type) or TABLE_B_CHIPS.get(place_type)
        if chip is None:
            continue
        if place_type in VAGUE_TYPES:
            vague.add(chip)
        else:
            precise.add(chip)

    matched = precise or vague
    if not matched:
        return [FALLBACK_CHIP]
    return [chip for chip in CHIP_TYPES if chip in matched]


#: Google's own label reads as a classification rather than a description for a
#: handful of types ("Lodging"), or over-claims on a listing it knows little
#: about. We name those in our own words; every other type keeps Google's
#: localized label, which is better than anything we would write.
DISPLAY_LABEL_OVERRIDES: dict[str, str] = {
    "lodging": "Place to stay",
    "guest_house": "Guest house",
    "private_guest_room": "Guest room",
    "extended_stay_hotel": "Serviced stay",
    "resort_hotel": "Resort",
    "establishment": "Place",
    "point_of_interest": "Place",
    "general_contractor": "Contractor",
    "real_estate_agency": "Estate agent",
    "association_or_organization": "Organisation",
    "service": "Service",
    "store": "Shop",
}


def display_label(primary_type: str | None, provider_label: str | None) -> str:
    """The one line under a place's name in the picker.

    Prefers our own wording where Google's is confusing, then Google's own
    localized label, then a readable form of the raw type, then "Place". Never
    empty: a row with no supporting line reads as a loading state.
    """

    override = DISPLAY_LABEL_OVERRIDES.get(str(primary_type or ""))
    if override:
        return override
    label = str(provider_label or "").strip()
    if label:
        return label[:80]
    readable = str(primary_type or "").replace("_", " ").strip()
    return readable.title()[:80] if readable else "Place"

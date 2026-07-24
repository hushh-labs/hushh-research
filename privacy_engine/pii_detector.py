import re

from patterns import (
    EMAIL_PATTERN,
    PHONE_PATTERN,
    CARD_PATTERN
)


def detect_pii(text):

    findings = {}

    findings["emails"] = re.findall(
        EMAIL_PATTERN,
        text
    )

    findings["phones"] = re.findall(
        PHONE_PATTERN,
        text
    )

    findings["cards"] = re.findall(
        CARD_PATTERN,
        text
    )

    return findings
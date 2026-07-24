import re

from patterns import (
    EMAIL_PATTERN,
    PHONE_PATTERN,
    CARD_PATTERN
)


def anonymize_text(text):

    text = re.sub(
        EMAIL_PATTERN,
        '[EMAIL_HIDDEN]',
        text
    )

    text = re.sub(
        PHONE_PATTERN,
        '[PHONE_HIDDEN]',
        text
    )

    text = re.sub(
        CARD_PATTERN,
        '[CARD_HIDDEN]',
        text
    )

    return text
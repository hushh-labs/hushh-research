def validate_input(text):

    if not text:
        return False

    if len(text) < 3:
        return False

    return True
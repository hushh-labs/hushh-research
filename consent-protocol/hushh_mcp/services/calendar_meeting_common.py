"""Shared transient provider availability states for Calendar meeting files."""


class ArtifactUnavailable(Exception):
    def __init__(self, state, *, retryable=False):
        self.state = state
        self.retryable = retryable

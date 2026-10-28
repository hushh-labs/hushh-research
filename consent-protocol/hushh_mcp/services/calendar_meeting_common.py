"""Shared transient provider availability states for Calendar meeting files."""


class ArtifactUnavailable(Exception):
    def __init__(self, state):
        self.state = state

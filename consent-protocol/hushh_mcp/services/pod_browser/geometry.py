"""Pure, bounded geometry checks; control and consent remain with BrowserControl."""

from .contracts import BrowserAction, BrowserFrame, BrowserRefused, BrowserViewport


def viewport_for_action(current: BrowserViewport, action: BrowserAction) -> BrowserViewport:
    if action.operation == "resize":
        return BrowserViewport.model_validate({"width": action.width, "height": action.height})
    for value, bound in (
        (action.x, current.width),
        (action.y, current.height),
        (action.destination_x, current.width),
        (action.destination_y, current.height),
    ):
        if value is not None and value >= bound:
            raise BrowserRefused("BROWSER_COORDINATES_INVALID")
    return current


def require_frame_geometry(
    frame: BrowserFrame, action: BrowserAction, viewport: BrowserViewport
) -> None:
    if frame.sequence != action.sequence or (frame.width, frame.height) != (
        viewport.width,
        viewport.height,
    ):
        raise BrowserRefused("BROWSER_FRAME_MISMATCH")

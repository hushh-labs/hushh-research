# UAT Responsive Test Matrix

Status: Not started.

This matrix defines the required verification set for the Apple iOS-first migration. It does not mark any route complete by itself.

## Visual Context

Canonical visual owner: [Quality and Design System Index](../reference/quality/README.md).

This matrix defines the viewport and state coverage needed to prove the Apple-system layout visually, including safe areas, keyboard behavior, overflow, and desktop whitespace.

## Required Viewports

| Device class | Viewport | Orientation | Status |
| --- | ---: | --- | --- |
| Small iPhone | 320 x 568 | Portrait | Not started |
| iPhone SE-style | 375 x 667 | Portrait | Not started |
| iPhone modern | 390 x 844 | Portrait | Not started |
| iPhone modern alt | 393 x 852 | Portrait | Not started |
| iPhone large | 430 x 932 | Portrait | Not started |
| iPad | 768 x 1024 | Portrait | Not started |
| iPad large | 820 x 1180 | Portrait | Not started |
| Tablet landscape | 1024 x 768 | Landscape | Not started |
| Desktop | 1280 x 800 | Landscape | Not started |
| Desktop wide | 1440 x 900 | Landscape | Not started |

## Required Route Checks

For every in-scope route:

- No horizontal document overflow.
- Page canvas matches the route archetype.
- Standard content cards are opaque and shadowless.
- Glass appears only on functional controls/navigation/overlays.
- Touch targets are at least 44 x 44 CSS pixels.
- Text does not overlap, clip, or become too small.
- Settings/account columns remain constrained on desktop.
- Desktop adds surrounding whitespace rather than enlarging components.
- Bottom tab bar, Talk to One, composer, and floating controls respect safe areas.
- Content scroll regions reserve enough bottom clearance.
- Keyboard does not hide focused controls or primary actions.
- Loading, empty, partial, error, modal/sheet, disabled, selected, success, validation error, long content, and short content states are checked where applicable.

## Browser Requirements

| Browser/platform | Status | Notes |
| --- | --- | --- |
| Local Chromium via Playwright | Not started | Fast regression baseline. |
| iOS Safari or equivalent device proof | Not started | Required before claiming UAT-complete. |
| Desktop browser | Not started | Required for whitespace/constrained-column proof. |

## Acceptance Rule

A route stays `Not started` or `In progress` in `docs/ui-migration/route-matrix.md` until the route has rendered proof for its relevant viewport set and state set.

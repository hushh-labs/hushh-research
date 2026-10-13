# Profile pane material: web attribution

## Visual Context

Canonical visual owner: [Quality and Design System Index](../../quality/README.md).

The bounded Profile, Chats and One panes share the material contract in
[App Surface Design System](../../quality/app-surface-design-system.md).
[Render Performance Charter](../render-performance-charter.md) owns device
certification; this report records a scoped browser comparison.

## Measurement

This is a browser attribution run, not a physical-device release certification.
The UI branch uses main `f687c2b641ba3f7068a8cffc19bb53fb96ecad9d` as its base.

The production Connections fixture and canonical `startFramePacingProbe` measured
three open/close cycles for Chats and One at 390 × 844. A paired CSS experiment
held the DOM and geometry fixed: the previous opaque fill/no filter was compared
with Profile's shared translucent material. Screenshots were outside the measured
windows. Raw exports and the experiment script remain in ignored `tmp/`.

| Engine | Before p99 maximum | After p99 maximum | Before / after frames | Frames over 50ms |
| --- | --- | --- | --- | --- |
| Chromium | 17ms | 17ms | 287 / 290 | 0 / 0 |
| WebKit test renderer | 37ms | 23ms | 318 / 307 | 0 / 0 |

Each variant recorded 18 input/settlement windows. Chromium rendered the glass.
The installed WebKit renderer reported the filter but did not render it, even
in an independent plain, untransformed blur experiment; its timings therefore
do not prove native blur cost or readability. Safari/WKWebView on a physical
device and native Android remain unverified. The existing Android filter
downgrade, shared scrim, motion tokens and gesture ownership are preserved.

Browser contracts compare the mounted production Profile pane with Chats and
One in both themes: material, type, header/body padding, leading visuals,
chevrons, separators and interactive/noninteractive row targets. Existing
drawer gestures, focus restoration, scrolling and state-mapped artwork retain
their own behavioral coverage. One's full Feed route keeps its normal geometry.

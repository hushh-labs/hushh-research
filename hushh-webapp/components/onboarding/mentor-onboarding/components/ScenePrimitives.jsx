// Mechanically recovered from the mentor HTML; JSX is emitted as React.createElement.
import * as React from "react";
const HEIGHTS = [8, 13, 23, 15, 30, 37, 20, 12, 28, 34, 18, 9, 22, 32, 18, 26, 12, 8, 18, 29, 16, 9];
export function VoiceWave() {
    return React.createElement("svg", { className: "ao-wave", viewBox: "0 0 154 42", preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true", focusable: "false" }, HEIGHTS.map((height, index) => React.createElement("rect", { key: index, x: index * 7 + 2, y: (42 - height) / 2, width: "3", height: height, rx: "1.5", fill: "currentColor" })));
}

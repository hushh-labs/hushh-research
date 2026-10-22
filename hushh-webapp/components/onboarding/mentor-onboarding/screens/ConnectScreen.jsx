// Mechanically recovered from the mentor HTML; JSX is emitted as React.createElement.
import * as React from "react";
import * as content_1 from "../content";
import * as SlideLayout_1 from "../components/SlideLayout";
import * as OneMascot_1 from "../components/OneMascot";
import * as CollageShapes_1 from "../components/CollageShapes";
import * as ScenePrimitives_1 from "../components/ScenePrimitives";
import * as Icons_1 from "../components/Icons";
export function ConnectScreen(props) {
    return React.createElement(SlideLayout_1.SlideLayout, { ...props, story: content_1.STORIES[2] },
        React.createElement(CollageShapes_1.CollageShapes, { story: "connect" }),
        React.createElement("div", { className: "ao-chat-bubble ao-enter-1" },
            React.createElement("span", { className: "ao-person-letter" }, "M"),
            React.createElement("div", null,
                React.createElement("span", null, "Mum"),
                React.createElement("strong", null, "Let me know you\u2019re home."))),
        React.createElement("div", { className: "ao-voice-note ao-enter-2" },
            React.createElement("span", { className: "ao-voice-note__play" },
                React.createElement(Icons_1.Icon, { name: "play", size: 16 })),
            React.createElement(ScenePrimitives_1.VoiceWave, null),
            React.createElement("span", { className: "ao-voice-time" }, "0:12")),
        React.createElement("div", { className: "ao-location-card ao-enter-3" },
            React.createElement("svg", { viewBox: "0 0 178 158", fill: "none", "aria-hidden": "true" },
                React.createElement("rect", { width: "178", height: "158", rx: "17", fill: "#EDF2EE" }),
                React.createElement("path", { d: "M-10 40L62 80L107 44L198 89M8-20L55 41L30 161M141-10L110 52L138 103L99 172M-15 128L58 98L190 129", stroke: "white", strokeWidth: "11", strokeLinejoin: "round" }),
                React.createElement("path", { d: "M49 119C64 102 49 80 77 79C107 79 99 62 117 49", stroke: "#0071E3", strokeWidth: "2.5", strokeDasharray: "4 5", strokeLinecap: "round" }),
                React.createElement("circle", { cx: "48", cy: "121", r: "7", fill: "#0071E3", stroke: "white", strokeWidth: "3" }),
                React.createElement("path", { d: "M132 40c0 12-16 26-16 26s-16-14-16-26a16 16 0 1 1 32 0Z", fill: "#FF715D" }),
                React.createElement("circle", { cx: "116", cy: "40", r: "5", fill: "white" })),
            React.createElement("span", null,
                React.createElement(Icons_1.Icon, { name: "pin", size: 13 }),
                "Shared for 1 hour")),
        React.createElement(OneMascot_1.OneMascot, { ...props, state: "answering", className: "ao-connect-mascot" }),
        React.createElement("div", { className: "ao-caption-sticker ao-connect-sticker ao-enter-4" },
            React.createElement("span", { className: "ao-check-disc" },
                React.createElement(Icons_1.Icon, { name: "check", size: 14 })),
            "Made it home."));
}

// Mechanically recovered from the mentor HTML; JSX is emitted as React.createElement.
import * as React from "react";
import * as content_1 from "../content";
import * as SlideLayout_1 from "../components/SlideLayout";
import * as OneMascot_1 from "../components/OneMascot";
import * as CollageShapes_1 from "../components/CollageShapes";
import * as Icons_1 from "../components/Icons";
export function AskScreen(props) {
    return React.createElement(SlideLayout_1.SlideLayout, { ...props, story: content_1.STORIES[0] },
        React.createElement(CollageShapes_1.CollageShapes, { story: "ask" }),
        React.createElement("div", { className: "ao-prompt ao-ask-prompt ao-enter-1" },
            React.createElement("span", null, "\u201CFind 30 minutes tomorrow.\u201D"),
            React.createElement(Icons_1.Icon, { name: "volume", size: 17 })),
        React.createElement("div", { className: "ao-mini-card ao-mail-card ao-enter-2" },
            React.createElement("div", { className: "ao-card-label" },
                React.createElement("span", { className: "ao-icon-tile ao-tile-pink" },
                    React.createElement(Icons_1.Icon, { name: "mail" })),
                "Mail"),
            React.createElement("strong", null, "Reply drafted."),
            React.createElement("p", null, "Ready for your review"),
            React.createElement("div", { className: "ao-text-lines" },
                React.createElement("i", null),
                React.createElement("i", null),
                React.createElement("i", null))),
        React.createElement("div", { className: "ao-mini-card ao-calendar-card ao-enter-3" },
            React.createElement("div", { className: "ao-card-label" },
                React.createElement("span", { className: "ao-icon-tile ao-tile-yellow" },
                    React.createElement(Icons_1.Icon, { name: "calendar" })),
                "Calendar"),
            React.createElement("span", { className: "ao-small-label" }, "Tomorrow"),
            React.createElement("strong", null,
                "10:30",
                React.createElement("span", null, "AM")),
            React.createElement("div", { className: "ao-slot" },
                React.createElement(Icons_1.Icon, { name: "clock", size: 13 }),
                "30 minutes free")),
        React.createElement(OneMascot_1.OneMascot, { ...props, state: "working", className: "ao-ask-mascot" }),
        React.createElement("div", { className: "ao-caption-sticker ao-ask-sticker ao-enter-4" },
            React.createElement("span", { className: "ao-check-disc" },
                React.createElement(Icons_1.Icon, { name: "check", size: 14 })),
            "Less on your plate."));
}

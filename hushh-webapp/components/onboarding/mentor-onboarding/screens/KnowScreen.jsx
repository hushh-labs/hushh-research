// Mechanically recovered from the mentor HTML; JSX is emitted as React.createElement.
import * as React from "react";
import * as content_1 from "../content";
import * as SlideLayout_1 from "../components/SlideLayout";
import * as OneMascot_1 from "../components/OneMascot";
import * as CollageShapes_1 from "../components/CollageShapes";
import * as Icons_1 from "../components/Icons";
export function KnowScreen(props) {
    return React.createElement(SlideLayout_1.SlideLayout, { ...props, story: content_1.STORIES[1] },
        React.createElement(CollageShapes_1.CollageShapes, { story: "know" }),
        React.createElement("div", { className: "ao-know-portrait" },
            React.createElement(OneMascot_1.OneMascot, { ...props, state: "thinking", className: "ao-know-mascot" })),
        React.createElement("div", { className: "ao-prompt ao-know-prompt ao-enter-1" },
            React.createElement(Icons_1.Icon, { name: "search", size: 17 }),
            React.createElement("span", { "data-location-type-role": "row-description" }, "Find my latest statement.")),
        React.createElement("div", { className: "ao-source-tag ao-source-files ao-enter-2" },
            React.createElement("span", { className: "ao-icon-tile ao-tile-pink" },
                React.createElement(Icons_1.Icon, { name: "folder" })),
            React.createElement("span", { "data-location-type-role": "row-description" }, "Files")),
        React.createElement("div", { className: "ao-source-tag ao-source-memory ao-enter-3" },
            React.createElement("span", { className: "ao-icon-tile ao-tile-yellow" },
                React.createElement(Icons_1.Icon, { name: "check" })),
            React.createElement("span", { "data-location-type-role": "row-description" }, "Memory")),
        React.createElement("div", { className: "ao-found-file ao-enter-4" },
            React.createElement("span", { className: "ao-found-file-icon" },
                React.createElement(Icons_1.Icon, { name: "file", size: 25 })),
            React.createElement("div", null,
                React.createElement("strong", { "data-location-type-role": "row-description" }, "Your statement"),
                React.createElement("span", { "data-location-type-role": "row-description" }, "Found in your files")),
            React.createElement("span", { className: "ao-file-found-check" },
                React.createElement(Icons_1.Icon, { name: "check", size: 13 }))));
}

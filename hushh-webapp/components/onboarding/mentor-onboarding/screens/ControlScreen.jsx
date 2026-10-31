// Mechanically recovered from the mentor HTML; JSX is emitted as React.createElement.
import * as React from "react";
import * as content_1 from "../content";
import * as SlideLayout_1 from "../components/SlideLayout";
import * as OneMascot_1 from "../components/OneMascot";
import * as CollageShapes_1 from "../components/CollageShapes";
import * as Icons_1 from "../components/Icons";
export function ControlScreen(props) {
    return React.createElement(SlideLayout_1.SlideLayout, { ...props, story: content_1.STORIES[3] },
        React.createElement(CollageShapes_1.CollageShapes, { story: "control" }),
        React.createElement("div", { className: "ao-permission-card ao-enter-1" },
            React.createElement("div", { className: "ao-permission-title" },
                React.createElement("span", { className: "ao-icon-tile ao-tile-pink" },
                    React.createElement(Icons_1.Icon, { name: "lock" })),
                React.createElement("strong", { "data-location-type-role": "section-heading" }, "Access request")),
            React.createElement("dl", null,
                React.createElement("div", null,
                    React.createElement("dt", { "data-location-type-role": "source-heading" }, "Who"),
                    React.createElement("dd", { "data-location-type-role": "row-title" }, "Your advisor")),
                React.createElement("div", null,
                    React.createElement("dt", { "data-location-type-role": "source-heading" }, "What"),
                    React.createElement("dd", { "data-location-type-role": "row-title" }, "3 selected files")),
                React.createElement("div", null,
                    React.createElement("dt", { "data-location-type-role": "source-heading" }, "For"),
                    React.createElement("dd", { "data-location-type-role": "row-title" }, "7 days"))),
            props.paidDocumentAccess ? React.createElement("p", { className: "ao-price-note" },
                React.createElement(Icons_1.Icon, { name: "wallet", size: 13 }),
                "One-time price \u00B7 You decide") : null,
            React.createElement("div", { className: "ao-approval-stamp" },
                React.createElement(Icons_1.Icon, { name: "check", size: 16 }),
                React.createElement("span", { "data-location-type-role": "status" }, "You decide."))),
        React.createElement(OneMascot_1.OneMascot, { ...props, state: "connected", className: "ao-control-mascot" }),
        React.createElement("div", { "data-location-type-role": "row-title", className: "ao-caption-sticker ao-control-sticker ao-enter-3" },
            React.createElement(Icons_1.Icon, { name: "lock", size: 14 }),
            "Only with your approval."));
}

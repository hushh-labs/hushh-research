// Mechanically recovered from the mentor HTML; JSX is emitted as React.createElement.
import * as React from "react";
/** Original, editable flat SVG scenery. Decorative only; product UI stays HTML. */
export function CollageShapes({ story }) {
    return React.createElement("svg", { className: "ao-collage-shapes", viewBox: "0 0 390 456", fill: "none", "aria-hidden": "true" },
        React.createElement("g", { transform: "translate(34 16) scale(.8)" },
            story === 'ask' ? React.createElement(React.Fragment, null,
                React.createElement("path", { d: "M-14 124C3 82 58 65 87 102C116 139 91 166 105 208C121 252 109 315 69 341C29 367-2 342-13 305C-29 253-42 189-14 124Z", fill: "#F7B5D5" }),
                React.createElement("path", { d: "M274 29C329 17 382 26 403 66C422 103 429 185 406 213C374 251 323 228 293 197C260 161 269 119 234 100C206 85 222 42 274 29Z", fill: "#FFDD6B" }),
                React.createElement("path", { d: "M258 281C324 242 385 280 417 318L378 361C348 332 320 325 284 348Z", fill: "#FF715D" }),
                React.createElement("path", { d: "M33 35l6 12m10-22 1 17m16-9-6 12", stroke: "#222326", strokeWidth: "2.4", strokeLinecap: "round" }),
                React.createElement("path", { d: "M297 363c-29 20-54 24-79 20m0 0 13-9m-13 9 13 6", stroke: "#222326", strokeWidth: "2.1", strokeLinecap: "round", strokeLinejoin: "round" })) : null,
            story === 'know' ? React.createElement(React.Fragment, null,
                React.createElement("path", { d: "M-25 106C7 59 28 75 30 116C13 43 53 45 68 107C64 28 104 33 100 112C123 47 159 69 130 131C181 86 204 122 156 161C213 147 218 188 154 193C199 227 173 256 127 223C142 277 101 282 92 231C78 284 40 264 55 219C8 253-13 218 27 189C-26 199-38 159 14 152C-25 138-35 132-25 106Z", fill: "#FFDD6B" }),
                React.createElement("path", { d: "M259 114C326 80 402 91 421 145C438 194 395 242 347 273C308 300 283 332 256 321C224 309 225 275 257 248C283 226 302 207 296 191C290 174 257 178 239 163C220 147 237 125 259 114Z", fill: "#FF715D" }),
                React.createElement("path", { d: "M150 249c52-33 120-13 134 37s-10 97-49 91c-31-5-37-45-61-41-38 7-62-63-24-87Z", fill: "#F7B5D5" }),
                React.createElement("path", { d: "M295 55c24 6 39 21 38 42m0 0-8-10m8 10 9-10", stroke: "#222326", strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round" }),
                React.createElement("path", { d: "m34 306-10 9m19-1-4 15", stroke: "#222326", strokeWidth: "2.3", strokeLinecap: "round" })) : null,
            story === 'connect' ? React.createElement(React.Fragment, null,
                React.createElement("path", { d: "M37 54C68 35 108 50 116 76C132 108 96 144 93 176C89 208 104 236 87 257C69 280 35 268 24 245C-1 195-10 111 8 78C16 64 25 59 37 54Z", fill: "#FF715D" }),
                React.createElement("path", { d: "M303 58c17-25 47-16 43 14c28-18 56-5 41 24c40-3 54 25 18 43c36 14 31 46-8 44c19 29 5 49-25 32c-5 39-36 41-46 8c-23 31-47 12-29-17c-38 7-51-22-19-37c-30-21-23-45 9-42c-29-30-8-52 19-28c-12-16-15-26-3-41Z", fill: "#F7B5D5" }),
                React.createElement("path", { d: "M62 262c8-50 59-85 116-73c39 9 55 41 88 57c57 27 51 84 1 98c-33 9-64-20-99-13c-57 10-112-13-106-69Z", fill: "#B8CFFF" }),
                React.createElement("path", { d: "M136 46c11-6 27-2 36 8m-38-5 1-8m1 8 9 1", stroke: "#222326", strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round" }),
                React.createElement("path", { d: "m329 327 13 4m-17 8 8 10m-21-8 2 13", stroke: "#222326", strokeWidth: "2.3", strokeLinecap: "round" })) : null,
            story === 'control' ? React.createElement(React.Fragment, null,
                React.createElement("path", { d: "M-16 87C20 27 77 37 100 75C134 25 186 63 168 105C153 140 131 149 107 177C77 212 46 218 19 192C-14 159-40 127-16 87Z", fill: "#F7B5D5" }),
                React.createElement("path", { d: "M315 48c28-20 72-6 84 30l36 152c6 35-14 57-50 48l-63-17c-25-7-35-36-13-54c20-17 13-39-5-62c-27-36-27-74 11-97Z", fill: "#FFDD6B" }),
                React.createElement("path", { d: "M21 312c25-21 51-6 88 0c42 8 72-16 84-2c18 21-4 55-43 57c-28 1-61-20-91-7c-44 19-66-24-38-48Z", fill: "#FF715D" }),
                React.createElement("path", { d: "M205 357c-29 22-73 22-93 7m0 0 14 0m-14 0 7 12", stroke: "#222326", strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round" }),
                React.createElement("path", { d: "m287 32 1-13m10 19 7-10", stroke: "#222326", strokeWidth: "2.3", strokeLinecap: "round" })) : null));
}

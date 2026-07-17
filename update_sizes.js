const fs = require('fs');

const path = 'hushh-webapp/components/app-ui/agent-section-icon.tsx';
let content = fs.readFileSync(path, 'utf8');

// The request is to increase the icon size by 1.5x.
// Current innerSizes:
// card: "h-7 w-7" (28px) => 1.5x => "h-[42px] w-[42px]" ~ "h-10 w-10" (40px) or "h-11 w-11" (44px)
// launcher: "h-8 w-8" (32px) => 1.5x => "h-[48px] w-[48px]" ~ "h-12 w-12"
// topbar: "h-5 w-5" (20px) => 1.5x => "h-[30px] w-[30px]" ~ "h-7 w-7" (28px) or "h-8 w-8" (32px)
// menu: "h-4 w-4" (16px) => 1.5x => "h-[24px] w-[24px]" ~ "h-6 w-6"

content = content.replace(
  /const innerSizes = \{\n\s*card: "h-7 w-7",\n\s*launcher: "h-8 w-8",\n\s*topbar: "h-5 w-5",\n\s*menu: "h-4 w-4"\n\s*\};/,
  \`const innerSizes = {
       card: "h-10 w-10",
       launcher: "h-12 w-12",
       topbar: "h-7 w-7",
       menu: "h-6 w-6"
     };\`/
);

fs.writeFileSync(path, content);
console.log("Increased Inner SVG bounds by ~1.5x");

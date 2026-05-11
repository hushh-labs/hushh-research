#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const STOCK_UI_FILES = new Set([
  "accordion.tsx",
  "alert-dialog.tsx",
  "alert.tsx",
  "avatar.tsx",
  "badge.tsx",
  "breadcrumb.tsx",
  "button-group.tsx",
  "button.tsx",
  "card.tsx",
  "carousel.tsx",
  "chart.tsx",
  "checkbox.tsx",
  "collapsible.tsx",
  "combobox.tsx",
  "command.tsx",
  "dialog.tsx",
  "drawer.tsx",
  "dropdown-menu.tsx",
  "empty.tsx",
  "field.tsx",
  "input-group.tsx",
  "input.tsx",
  "kbd.tsx",
  "label.tsx",
  "pagination.tsx",
  "popover.tsx",
  "progress.tsx",
  "radio-group.tsx",
  "scroll-area.tsx",
  "select.tsx",
  "semantic-loader.tsx",
  "separator.tsx",
  "sheet.tsx",
  "sidebar.tsx",
  "skeleton.tsx",
  "sonner.tsx",
  "spinner.tsx",
  "switch.tsx",
  "table.tsx",
  "tabs.tsx",
  "textarea.tsx",
  "tooltip.tsx",
]);

function verifyDesignSystem() {
  const uiDir = path.join(repoRoot, "components", "ui");
  
  if (!fs.existsSync(uiDir)) {
    return;
  }

  const files = fs.readdirSync(uiDir);
  const violations = [];

  for (const file of files) {
    if (file.endsWith(".tsx") && !STOCK_UI_FILES.has(file)) {
      violations.push(file);
    }
  }

  if (violations.length > 0) {
    console.error("\nDesign-system verification failed:\n");
    console.error("- components/ui contains non-contract files:", violations.join(", "));
    console.error("\nAny custom components must be placed in components/app-ui, not components/ui.");
    process.exit(1);
  }
}

verifyDesignSystem();
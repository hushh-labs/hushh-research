// lib/format-message.tsx

/**
 * Simple message formatter for chat bubbles
 * Converts markdown-like syntax to JSX without external dependencies
 */

import React from "react";

interface _FormattedMessage {
  type: "text" | "bold" | "bullet" | "divider" | "heading";
  content: string;
}

/**
 * Parse message content and return JSX
 */
export function formatMessage(content: string): React.ReactNode {
  if (!content) return null;
  const lines = content.split("\n");

  return lines.map((line, lineIndex) => {
    // Handle horizontal rule
    if (line.trim() === "---") {
      return (
        <hr
          key={lineIndex}
          className="my-3 border-gray-200 dark:border-gray-700"
        />
      );
    }

    // Handle bullet points
    if (line.trim().startsWith("•") || line.trim().startsWith("-")) {
      const bulletContent = line.replace(/^[\s]*[•\-]\s*/, "");
      return (
        <div key={lineIndex} className="flex items-start gap-2 pl-2 py-0.5">
          <span className="text-muted-foreground mt-0.5">•</span>
          <span>{parseBoldText(bulletContent)}</span>
        </div>
      );
    }

    // Handle headings (lines starting with emoji or all caps)
    if (line.match(/^[📋🥗🍽️💰✅🎉👋].*/)) {
      return (
        <div key={lineIndex} className="font-semibold mt-2 first:mt-0">
          {parseBoldText(line)}
        </div>
      );
    }

    // Regular line with bold parsing
    return (
      <React.Fragment key={lineIndex}>
        {parseBoldText(line)}
        {lineIndex < lines.length - 1 && <br />}
      </React.Fragment>
    );
  });
}

/**
 * Parse **bold** text within a line
 */
function parseBoldText(text: string): React.ReactNode {
  // Split by **text** pattern
  const parts = text.split(/(\*\*[^*]+\*\*)/g);

  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      // Remove ** and render as bold
      const boldText = part.slice(2, -2);
      return (
        <strong key={index} className="font-semibold text-foreground">
          {boldText}
        </strong>
      );
    }
    return part;
  });
}

/**
 * Parse collected data from session state for display
 */
export function formatCollectedData(
  collected: Record<string, unknown>
): { label: string; value: string; emoji: string }[] {
  const items: { label: string; value: string; emoji: string }[] = [];

  // Food domain fields
  if (collected.dietary_restrictions) {
    const dietary = collected.dietary_restrictions as string[];
    items.push({
      label: "Dietary",
      value: dietary.length > 0 ? dietary.join(", ") : "None",
      emoji: "🥗",
    });
  }

  if (collected.cuisine_preferences) {
    const cuisines = collected.cuisine_preferences as string[];
    items.push({
      label: "Cuisines",
      value: cuisines.join(", "),
      emoji: "🍽️",
    });
  }

  if (collected.monthly_budget) {
    items.push({
      label: "Budget",
      value: `$${collected.monthly_budget}/month`,
      emoji: "💰",
    });
  }

  // Professional profile fields
  if (collected.professional_title) {
    items.push({
      label: "Title",
      value: String(collected.professional_title),
      emoji: "💼",
    });
  }

  if (collected.skills) {
    const skills = collected.skills as string[];
    items.push({
      label: "Skills",
      value:
        skills.length > 3
          ? `${skills.slice(0, 3).join(", ")} +${skills.length - 3}`
          : skills.join(", "),
      emoji: "🛠️",
    });
  }

  if (collected.experience_level) {
    items.push({
      label: "Experience",
      value: String(collected.experience_level),
      emoji: "📊",
    });
  }

  if (collected.job_preferences) {
    const prefs = collected.job_preferences as string[];
    items.push({
      label: "Looking for",
      value: prefs.join(", "),
      emoji: "🎯",
    });
  }

  // Handle custom fields
  if (collected.custom && typeof collected.custom === "object") {
    for (const [key, value] of Object.entries(
      collected.custom as Record<string, unknown>
    )) {
      items.push({
        label: key.replace(/_/g, " "),
        value: String(value),
        emoji: "📝",
      });
    }
  }

  return items;
}

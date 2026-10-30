import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ["var(--font-app-body)"],
        heading: [
          "var(--font-app-display)",
        ],
        display: [
          "var(--font-app-display)",
        ],
        mono: ["var(--font-app-body)"],
      },
      fontSize: {
        xs: ["var(--foundation-caption-size)", { lineHeight: "var(--foundation-caption-line)" }],
        sm: ["var(--foundation-footnote-size)", { lineHeight: "var(--foundation-footnote-line)" }],
        base: ["var(--foundation-body-size)", { lineHeight: "var(--foundation-body-line)" }],
        lg: ["var(--foundation-headline-size)", { lineHeight: "var(--foundation-headline-line)" }],
        xl: ["var(--foundation-title3-size)", { lineHeight: "var(--foundation-title3-line)" }],
        "2xl": ["var(--foundation-title2-size)", { lineHeight: "var(--foundation-title2-line)" }],
        "3xl": ["var(--foundation-title1-size)", { lineHeight: "var(--foundation-title1-line)" }],
        "4xl": ["var(--foundation-title1-size)", { lineHeight: "var(--foundation-title1-line)" }],
        "5xl": ["var(--foundation-display-size)", { lineHeight: "var(--foundation-display-line)" }],
        "6xl": ["var(--foundation-display-size)", { lineHeight: "var(--foundation-display-line)" }],
        "7xl": ["var(--foundation-display-size)", { lineHeight: "var(--foundation-display-line)" }],
        "8xl": ["var(--foundation-display-size)", { lineHeight: "var(--foundation-display-line)" }],
        "9xl": ["var(--foundation-display-size)", { lineHeight: "var(--foundation-display-line)" }],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Hussh brand colors
        hushh: {
          // Primary blue palette
          blue: {
            50: "#eff6ff",
            100: "#dbeafe",
            200: "#bfdbfe",
            300: "#93c5fd",
            400: "#60a5fa",
            500: "#0071e3", // Primary - Apple Blue
            600: "#0051a8",
            700: "#003d7a",
            800: "#002952",
            900: "#001429",
          },
          // Secondary emerald palette
          emerald: {
            50: "#ecfdf5",
            100: "#d1fae5",
            200: "#a7f3d0",
            300: "#6ee7b7",
            400: "#34d399",
            500: "#10b981", // Primary - Emerald
            600: "#059669",
            700: "#047857",
            800: "#065f46",
            900: "#064e3b",
          },
          // Accent teal
          teal: {
            500: "#0d7590",
            600: "#0a5a70",
          },
          // Dark navy
          navy: {
            500: "#13405d",
            600: "#0d2e42",
          },
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "var(--radius-xl)",
        "2xl": "calc(var(--radius) * 1.5)",
        "3xl": "calc(var(--radius) * 2)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;

export default config;

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

export type UseThemeProps = {
  themes: string[];
  forcedTheme?: string;
  setTheme: Dispatch<SetStateAction<string>>;
  theme?: string;
  resolvedTheme?: string;
  systemTheme?: "dark" | "light";
};

export type ThemeProviderProps = {
  children: ReactNode;
  themes?: string[];
  forcedTheme?: string;
  enableSystem?: boolean;
  enableColorScheme?: boolean;
  storageKey?: string;
  defaultTheme?: string;
  attribute?: "class" | `data-${string}` | Array<"class" | `data-${string}`>;
  value?: Record<string, string>;
};

const DEFAULT_THEMES = ["light", "dark"];
const ThemeContext = createContext<UseThemeProps | null>(null);
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

function getSystemTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia(MEDIA_QUERY).matches ? "dark" : "light";
}

function normalizeTheme(value: string | undefined, fallback: string): string {
  const normalized = (value || "").trim();
  return normalized || fallback;
}

function readStoredTheme(storageKey: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    return normalizeTheme(window.localStorage.getItem(storageKey) || undefined, fallback);
  } catch {
    return fallback;
  }
}

function applyTheme(params: {
  theme: string;
  enableSystem: boolean;
  enableColorScheme: boolean;
  attribute: ThemeProviderProps["attribute"];
  themes: string[];
  value?: Record<string, string>;
  systemTheme: "dark" | "light";
}) {
  if (typeof document === "undefined") return;

  const resolved =
    params.theme === "system" && params.enableSystem
      ? params.systemTheme
      : params.theme;
  const attributeValue = params.value?.[resolved] ?? resolved;
  const root = document.documentElement;
  const attributes = Array.isArray(params.attribute)
    ? params.attribute
    : [params.attribute ?? "class"];
  const classNames = params.themes
    .map((theme) => params.value?.[theme] ?? theme)
    .filter(Boolean);

  for (const attribute of attributes) {
    if (attribute === "class") {
      root.classList.remove(...classNames);
      if (attributeValue) root.classList.add(attributeValue);
    } else if (attributeValue) {
      root.setAttribute(attribute, attributeValue);
    } else {
      root.removeAttribute(attribute);
    }
  }

  if (params.enableColorScheme && (resolved === "light" || resolved === "dark")) {
    root.style.colorScheme = resolved;
  }
}

export function useTheme(): UseThemeProps {
  return (
    useContext(ThemeContext) ?? {
      themes: [],
      setTheme: () => undefined,
    }
  );
}

export function ThemeProvider({
  children,
  themes = DEFAULT_THEMES,
  forcedTheme,
  enableSystem = true,
  enableColorScheme = true,
  storageKey = "theme",
  defaultTheme = enableSystem ? "system" : "light",
  attribute = "class",
  value,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState(() =>
    readStoredTheme(storageKey, defaultTheme),
  );
  const [systemTheme, setSystemTheme] = useState<"dark" | "light">(() =>
    getSystemTheme(),
  );

  const activeTheme = forcedTheme ?? theme;
  const resolvedTheme =
    activeTheme === "system" && enableSystem ? systemTheme : activeTheme;

  const setTheme = useCallback<Dispatch<SetStateAction<string>>>(
    (next) => {
      setThemeState((current) => {
        const nextTheme =
          typeof next === "function" ? next(current) : normalizeTheme(next, defaultTheme);
        try {
          window.localStorage.setItem(storageKey, nextTheme);
        } catch {
          // Ignore storage failures; the in-memory theme still updates.
        }
        return nextTheme;
      });
    },
    [defaultTheme, storageKey],
  );

  useEffect(() => {
    const media = window.matchMedia(MEDIA_QUERY);
    const update = () => setSystemTheme(getSystemTheme());
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      setThemeState(normalizeTheme(event.newValue || undefined, defaultTheme));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [defaultTheme, storageKey]);

  useEffect(() => {
    applyTheme({
      theme: activeTheme,
      enableSystem,
      enableColorScheme,
      attribute,
      themes,
      value,
      systemTheme,
    });
  }, [
    activeTheme,
    attribute,
    enableColorScheme,
    enableSystem,
    systemTheme,
    themes,
    value,
  ]);

  const contextValue = useMemo<UseThemeProps>(
    () => ({
      theme,
      setTheme,
      forcedTheme,
      resolvedTheme,
      themes: enableSystem ? [...themes, "system"] : themes,
      systemTheme: enableSystem ? systemTheme : undefined,
    }),
    [enableSystem, forcedTheme, resolvedTheme, setTheme, systemTheme, theme, themes],
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}

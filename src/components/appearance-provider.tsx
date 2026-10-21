"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type AppearanceLanguage = "zh-CN" | "en";
export type AppearanceTheme = "light" | "dark" | "system";
export type ResolvedAppearanceTheme = "light" | "dark";

type AppearanceContextValue = Readonly<{
  language: AppearanceLanguage;
  theme: AppearanceTheme;
  resolvedTheme: ResolvedAppearanceTheme;
  setLanguage: (language: AppearanceLanguage) => void;
  setTheme: (theme: AppearanceTheme) => void;
  languageLoading: boolean;
  languageError: string | null;
  t: (text: string) => string;
  messages: UiMessages | null;
  dictionaryUrl: string;
}>;

export type AppearancePreference = Readonly<{
  language: AppearanceLanguage;
  theme: AppearanceTheme;
}>;

const LANGUAGE_COOKIE = "aipos-language";
const THEME_COOKIE = "aipos-theme";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const APPEARANCE_CHANGE_EVENT = "aipos:appearance-change";
const DEFAULT_PREFERENCE: AppearancePreference = { language: "zh-CN", theme: "light" };
type UiMessages = Readonly<Record<string, string>>;
const CORE_MESSAGES: UiMessages = {
  "工作台": "Dashboard", "智能问答": "Ask AI", "我的项目": "My projects", "我的知识": "My knowledge", "知识图谱": "Knowledge graph",
  "语言与外观": "Language and appearance",
  "语言": "Language", "中文": "Chinese", "主题": "Theme",
  "浅色": "Light", "深色": "Dark", "跟随系统": "System",
  "正在加载语言…": "Loading language…", "语言包加载失败，请重试。": "Could not load the language. Please try again.",
};
const englishRequests = new Map<string, Promise<UiMessages>>();
export function loadEnglishMessages(url: string): Promise<UiMessages> {
  const cached = englishRequests.get(url);
  if (cached) return cached;
  const request = fetch(url, { cache: "force-cache", credentials: "same-origin" }).then(async (response) => {
    if (!response.ok) throw new Error("LANGUAGE_RESOURCE_UNAVAILABLE");
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((text) => typeof text !== "string")) {
      throw new Error("LANGUAGE_RESOURCE_INVALID");
    }
    return value as UiMessages;
  }).catch((error: unknown) => { englishRequests.delete(url); throw error; });
  englishRequests.set(url, request);
  return request;
}
const AppearanceContext = createContext<AppearanceContextValue | null>(null);
let memoryPreference: AppearancePreference | null = null;

export function isAppearanceLanguage(value: unknown): value is AppearanceLanguage {
  return value === "zh-CN" || value === "en";
}

export function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return value === "light" || value === "dark" || value === "system";
}

export function normalizeAppearancePreference(
  language: unknown,
  theme: unknown,
  fallback: AppearancePreference = DEFAULT_PREFERENCE,
): AppearancePreference {
  return {
    language: isAppearanceLanguage(language) ? language : fallback.language,
    theme: isAppearanceTheme(theme) ? theme : fallback.theme,
  };
}

export function updateAppearancePreference(
  current: AppearancePreference,
  update: Partial<AppearancePreference>,
): AppearancePreference {
  return normalizeAppearancePreference(
    update.language ?? current.language,
    update.theme ?? current.theme,
    current,
  );
}

export function resolveAppearanceTheme(
  theme: AppearanceTheme,
  systemIsDark: boolean,
): ResolvedAppearanceTheme {
  return theme === "system" ? (systemIsDark ? "dark" : "light") : theme;
}

function readCookie(name: string): string | undefined {
  try {
    const prefix = `${name}=`;
    const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
    if (!cookie) return undefined;
    return decodeURIComponent(cookie.slice(prefix.length));
  } catch {
    return undefined;
  }
}

function writeCookie(name: string, value: string): boolean {
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
    return true;
  } catch {
    // Keep the current tab usable when browser cookie storage is unavailable.
    return false;
  }
}

function writePreference(preference: AppearancePreference): void {
  memoryPreference = preference;
  if (writeCookie(LANGUAGE_COOKIE, preference.language) && writeCookie(THEME_COOKIE, preference.theme)) {
    memoryPreference = null;
  }
  window.dispatchEvent(new Event(APPEARANCE_CHANGE_EVENT));
}

function subscribePreferences(onChange: () => void): () => void {
  window.addEventListener(APPEARANCE_CHANGE_EVENT, onChange);
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener(APPEARANCE_CHANGE_EVENT, onChange);
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

function subscribeSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function readSystemTheme(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function encodeAppearancePreference(preference: AppearancePreference): string {
  return `${preference.language}|${preference.theme}`;
}

export function decodeAppearancePreference(snapshot: string): AppearancePreference {
  const [language, theme] = snapshot.split("|");
  return normalizeAppearancePreference(language, theme);
}

export function translateUiText(text: string, language: AppearanceLanguage, messages: UiMessages = CORE_MESSAGES): string {
  if (language === "zh-CN") return text;
  return messages[text] ?? CORE_MESSAGES[text] ?? text;
}

export function AppearanceProvider({
  children,
  initialLanguage = DEFAULT_PREFERENCE.language,
  initialTheme = DEFAULT_PREFERENCE.theme,
  initialMessages = null,
  dictionaryUrl = "/locales/en.json",
}: Readonly<{
  children: ReactNode;
  initialLanguage?: AppearanceLanguage;
  initialTheme?: AppearanceTheme;
  initialMessages?: UiMessages | null;
  dictionaryUrl?: string;
}>): React.JSX.Element {
  const [messages, setMessages] = useState<UiMessages | null>(initialMessages);
  const [languageLoading, setLanguageLoading] = useState(false);
  const [languageError, setLanguageError] = useState<string | null>(null);
  const languageRequest = useRef(0);
  const serverPreferenceSnapshot = useCallback(() => encodeAppearancePreference({ language: initialLanguage, theme: initialTheme }), [initialLanguage, initialTheme]);
  const clientPreferenceSnapshot = useCallback(() => {
    if (memoryPreference) return encodeAppearancePreference(memoryPreference);
    const storedLanguage = readCookie(LANGUAGE_COOKIE);
    const storedTheme = readCookie(THEME_COOKIE);
    return encodeAppearancePreference(normalizeAppearancePreference(storedLanguage, storedTheme, {
      language: initialLanguage,
      theme: initialTheme,
    }));
  }, [initialLanguage, initialTheme]);
  const preferenceSnapshot = useSyncExternalStore(subscribePreferences, clientPreferenceSnapshot, serverPreferenceSnapshot);
  const { language, theme } = decodeAppearancePreference(preferenceSnapshot);
  const systemIsDark = useSyncExternalStore(subscribeSystemTheme, readSystemTheme, () => false);
  const resolvedTheme = resolveAppearanceTheme(theme, systemIsDark);

  useEffect(() => {
    const root = document.documentElement;
    if (
      root.lang === language &&
      root.dataset.language === language &&
      root.dataset.themePreference === theme &&
      root.dataset.theme === resolvedTheme
    ) return;

    root.lang = language;
    root.dataset.language = language;
    root.dataset.themePreference = theme;
    root.dataset.theme = resolvedTheme;
  }, [language, resolvedTheme, theme]);

  const setLanguage = useCallback((nextLanguage: AppearanceLanguage) => {
    const sequence = ++languageRequest.current;
    setLanguageError(null);
    const commit = () => {
      // Theme may have changed while an English resource was downloading.
      const current = memoryPreference ?? normalizeAppearancePreference(readCookie(LANGUAGE_COOKIE), readCookie(THEME_COOKIE), { language, theme });
      writePreference(updateAppearancePreference(current, { language: nextLanguage }));
    };
    if (nextLanguage !== "en" || messages !== null) { setLanguageLoading(false); commit(); return; }
    setLanguageLoading(true);
    void loadEnglishMessages(dictionaryUrl).then((loaded) => {
      if (sequence !== languageRequest.current) return;
      setMessages(loaded);
      commit();
    }).catch(() => {
      if (sequence === languageRequest.current) setLanguageError("语言包加载失败，请重试。");
    }).finally(() => {
      if (sequence === languageRequest.current) setLanguageLoading(false);
    });
  }, [dictionaryUrl, language, messages, theme]);

  useEffect(() => {
    // A preference changed in another tab; restore its resource without
    // remounting this tab's forms or losing unsaved input.
    if (language !== "en" || messages !== null) return;
    let cancelled = false;
    void loadEnglishMessages(dictionaryUrl).then((loaded) => {
      if (!cancelled) setMessages(loaded);
    }).catch(() => {
      if (!cancelled) setLanguageError("语言包加载失败，请重试。");
    });
    return () => { cancelled = true; };
  }, [dictionaryUrl, language, messages]);

  const setTheme = useCallback((nextTheme: AppearanceTheme) => {
    writePreference(updateAppearancePreference({ language, theme }, { theme: nextTheme }));
  }, [language, theme]);

  const t = useCallback((text: string) => translateUiText(text, language, messages ?? CORE_MESSAGES), [language, messages]);
  const value = useMemo<AppearanceContextValue>(() => ({ language, theme, resolvedTheme, setLanguage, setTheme, languageLoading, languageError, t, messages, dictionaryUrl }), [messages, dictionaryUrl, language, resolvedTheme, setLanguage, setTheme, languageLoading, languageError, t, theme]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance must be used within an AppearanceProvider");
  return value;
}

export function useTranslate(): AppearanceContextValue["t"] {
  return useAppearance().t;
}

export function UiText({ text }: Readonly<{ text: string }>): React.JSX.Element {
  const { t } = useAppearance();
  return <>{t(text)}</>;
}


/** Keep the feedback shell shared; load its interpreter only when feedback appears. */
export function UiErrorText({ text, kind = "error" }: Readonly<{ text: string; kind?: "error" | "status" }>): React.JSX.Element {
  const { language, messages, dictionaryUrl } = useAppearance();
  const key = `${language}\0${kind}\0${dictionaryUrl}\0${text}`;
  const [resolved, setResolved] = useState<Readonly<{ key: string; value: string }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([import("@/lib/ui-error-text"), messages ?? loadEnglishMessages(dictionaryUrl)]).then(([interpreter, dictionary]) => {
      if (!cancelled) setResolved({ key, value: interpreter.translateUiErrorText(text, language, dictionary, kind) });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [dictionaryUrl, key, kind, language, messages, text]);
  return <>{resolved?.key === key ? resolved.value : (language === "en" ? "Review the current status." : "请核对当前状态。")}</>;
}

export function UiFeedbackText({ text }: Readonly<{ text: string }>): React.JSX.Element {
  return <UiErrorText text={text} kind="status" />;
}

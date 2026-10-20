"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useAppearance } from "@/components/appearance-provider";

export function AppearanceControls(): React.JSX.Element {
  const { language, theme, setLanguage, setTheme, languageLoading, languageError, t } = useAppearance();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="appearance-controls" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="appearance-controls-trigger"
        aria-label={t("语言与外观")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
          <path d="M10 2.4a7.6 7.6 0 1 0 0 15.2h1.1c1.2 0 1.9-1.3 1.3-2.3-.4-.6-.2-1.4.4-1.8.2-.1.5-.2.7-.2h1.2c1.7 0 3-1.3 3-3A7.9 7.9 0 0 0 10 2.4Z" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="6.3" cy="8" r="1" fill="currentColor" />
          <circle cx="9.4" cy="5.8" r="1" fill="currentColor" />
          <circle cx="13.2" cy="7" r="1" fill="currentColor" />
        </svg>
        <span>{language === "en" ? "English" : "中文"}</span>
        <svg className="appearance-controls-chevron" aria-hidden="true" viewBox="0 0 16 16" fill="none">
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div id={popoverId} role="dialog" aria-label={t("语言与外观")} className="appearance-controls-popover">
          <label className="appearance-controls-row">
            <span>{t("语言")}</span>
            <select value={language} disabled={languageLoading} aria-busy={languageLoading} onChange={(event) => setLanguage(event.currentTarget.value as "zh-CN" | "en")}>
              <option value="zh-CN">{t("中文")}</option>
              <option value="en">English</option>
            </select>
          </label>
          {languageLoading ? <p role="status" className="appearance-feedback">{t("正在加载语言…")}</p> : null}
          {languageError ? <p role="alert" className="appearance-feedback">{t(languageError)}</p> : null}
          <label className="appearance-controls-row">
            <span>{t("主题")}</span>
            <select value={theme} onChange={(event) => setTheme(event.currentTarget.value as "light" | "dark" | "system")}>
              <option value="light">{t("浅色")}</option>
              <option value="dark">{t("深色")}</option>
              <option value="system">{t("跟随系统")}</option>
            </select>
          </label>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useAppearance } from "@/components/appearance-provider";
import { ShellIcon } from "@/components/shell-icon";

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
        <ShellIcon name="gear" className="app-icon--control" />
        <span>{language === "en" ? "English" : "中文"}</span>
        <ShellIcon name="down" className="appearance-controls-chevron app-icon--meta" />
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

"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useTranslate } from "./appearance-provider";
import { ShellIcon } from "./shell-icon";

const fallback = new Map<string, string>();
const changed = "ai-project-os:workspace-changed";
const key = (username: string) => `ai-project-os:workspace:${username}`;

export function selectWorkspace(username: string, id: string) {
  fallback.set(key(username), id);
  try { localStorage.setItem(key(username), id); } catch { /* Storage may be unavailable. */ }
  window.dispatchEvent(new CustomEvent(changed, { detail: { username, id } }));
}

export function useWorkspaceSelection(username: string) {
  return useSyncExternalStore(
    (callback) => {
      window.addEventListener(changed, callback);
      window.addEventListener("storage", callback);
      return () => {
        window.removeEventListener(changed, callback);
        window.removeEventListener("storage", callback);
      };
    },
    () => {
      try { return localStorage.getItem(key(username)) || ""; } catch { return fallback.get(key(username)) || ""; }
    },
    () => "",
  );
}

type Space = { id: string; name: string; personal?: boolean };

export function WorkspacePicker({ username, onNameChange }: { username: string; onNameChange?: (name: string) => void }) {
  const t = useTranslate();
  const router = useRouter();
  const selected = useWorkspaceSelection(username);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const pickerId = useId();
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = spaces.findIndex((space) => space.id === selected);
  const activeSpace = spaces.find((space) => space.id === selected);
  const buttonLabel = spaces.length === 0 ? t(failed ? "工作空间暂不可用" : "正在读取工作空间…") : activeSpace?.name || username;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const personalResponse = await fetch("/api/workspaces/current", { cache: "no-store", signal: controller.signal });
        if (!personalResponse.ok) throw Error();
        const personal = await personalResponse.json();
        if (controller.signal.aborted) return;
        const home = personal.overview.workspace;
        const available = Array.isArray(personal.availableWorkspaces) ? personal.availableWorkspaces : [];
        const list: Space[] = [{ id: home.id, name: home.name, personal: true }, ...available.filter((space: Space) => typeof space.id === "string" && typeof space.name === "string")];
        const unique = list.filter((space, index) => list.findIndex((candidate) => candidate.id === space.id) === index);
        setSpaces(unique);
        setFailed(false);
        let saved = "";
        try { saved = localStorage.getItem(key(username)) || ""; } catch { /* Storage may be unavailable. */ }
        if (!unique.some((space) => space.id === saved)) selectWorkspace(username, unique[0]?.id || "");
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [username, version]);

  useEffect(() => {
    onNameChange?.(activeSpace?.name || "");
  }, [activeSpace?.name, onNameChange]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
  }, [open, activeIndex]);

  function openPicker() {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function focusOption(index: number) {
    const boundedIndex = Math.max(0, Math.min(spaces.length - 1, index));
    setActiveIndex(boundedIndex);
    optionRefs.current[boundedIndex]?.focus();
  }

  function closePicker(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (open) focusOption(activeIndex);
      else openPicker();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) closePicker(false);
      else openPicker();
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
    }
  }

  function handleOptionKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") { event.preventDefault(); focusOption(index + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusOption(index - 1); }
    else if (event.key === "Home") { event.preventDefault(); focusOption(0); }
    else if (event.key === "End") { event.preventDefault(); focusOption(spaces.length - 1); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePicker(true); }
  }

  function chooseWorkspace(id: string) {
    selectWorkspace(username, id);
    closePicker(true);
    router.push("/dashboard");
  }

  return (
    <div
      ref={pickerRef}
      className="workspace-switcher"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="workspace-picker-trigger"
        role="combobox"
        aria-label={t("切换工作空间")}
        aria-haspopup="listbox"
        aria-controls={`${pickerId}-options`}
        aria-expanded={open}
        aria-activedescendant={open ? `${pickerId}-option-${activeIndex}` : undefined}
        disabled={!spaces.length}
        onClick={() => { if (open) closePicker(false); else openPicker(); }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span aria-hidden="true" className="workspace-initial">{(activeSpace?.name || username).slice(0, 1)}</span>
        <span className="workspace-name">{buttonLabel}</span>
        <ShellIcon name="down" className="workspace-picker-chevron" />
      </button>
      <div id={`${pickerId}-options`} className="workspace-options" role="listbox" aria-label={t("切换工作空间")} hidden={!open}>
        {spaces.map((space, index) => (
          <button
            key={space.id}
            ref={(element) => { optionRefs.current[index] = element; }}
            id={`${pickerId}-option-${index}`}
            type="button"
            role="option"
            aria-selected={space.id === selected}
            tabIndex={index === activeIndex ? 0 : -1}
            className="workspace-option"
            onClick={() => chooseWorkspace(space.id)}
            onKeyDown={(event) => handleOptionKeyDown(event, index)}
          >
            <span aria-hidden="true" className="workspace-initial">{space.name.slice(0, 1)}</span>
            <span className="workspace-option-name">{space.name}</span>
          </button>
        ))}
      </div>
      {failed ? <button className="workspace-retry" onClick={() => setVersion((value) => value + 1)}>{t("重试")}</button> : null}
    </div>
  );
}

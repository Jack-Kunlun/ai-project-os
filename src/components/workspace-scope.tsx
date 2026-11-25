"use client";

import { lazy, Suspense, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes } from "react";
import { useRouter } from "next/navigation";
import { useTranslate } from "./appearance-provider";
import { ShellIcon } from "./shell-icon";
import styles from "./user-shell.module.css";

const WorkspaceSearchPanel = lazy(() => import("./workspace-search-panel").then((module) => ({ default: module.WorkspaceSearchPanel })));

const fallback = new Map<string, string>();
const changed = "ai-project-os:workspace-changed";
const key = (username: string) => `ai-project-os:workspace:${username}`;

type SidebarSelectProps = SelectHTMLAttributes<HTMLSelectElement> & Readonly<{
  initial: string;
  children: ReactNode;
}>;

export function SidebarSelect({ initial, children, onKeyDown, ...props }: SidebarSelectProps): React.JSX.Element {
  return (
    <label className={styles.projectPicker}>
      <span className={styles.projectDot} aria-hidden="true">{initial.slice(0, 1) || "·"}</span>
      <select
        {...props}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
          onKeyDown?.(event);
        }}
      >
        {children}
      </select>
      <ShellIcon className={styles.icon} name="chevron" />
    </label>
  );
}

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

export type WorkspaceOption = { id: string; name: string; personal?: boolean; unavailable?: boolean };

export function WorkspacePicker({ username, onNameChange }: { username: string; onNameChange?: (name: string) => void }) {
  const t = useTranslate();
  const router = useRouter();
  const selected = useWorkspaceSelection(username);
  const [spaces, setSpaces] = useState<WorkspaceOption[]>([]);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownId = useId();
  const activeSpace = spaces.find((space) => space.id === selected);
  const optionLabel = t(failed ? "工作空间暂不可用" : "正在读取工作空间…");

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
        const list: WorkspaceOption[] = [{ id: home.id, name: home.name, personal: true }, ...available.filter((space: WorkspaceOption) => typeof space.id === "string" && typeof space.name === "string")];
        const unique = list.filter((space, index) => list.findIndex((candidate) => candidate.id === space.id) === index);
        let saved = "";
        try { saved = localStorage.getItem(key(username)) || ""; } catch { /* Storage may be unavailable. */ }
        if (saved && !unique.some((space) => space.id === saved)) {
          try {
            const selectedResponse = await fetch(`/api/workspaces/current?workspaceId=${encodeURIComponent(saved)}`, { cache: "no-store", signal: controller.signal });
            if (selectedResponse.status === 400) {
              selectWorkspace(username, home.id);
            } else if (!selectedResponse.ok) {
              throw Error();
            } else {
              const selectedBody = await selectedResponse.json();
              if (controller.signal.aborted) return;
              const selectedWorkspace = selectedBody.selectedWorkspace as WorkspaceOption | null;
              if (selectedWorkspace && typeof selectedWorkspace.id === "string" && typeof selectedWorkspace.name === "string") unique.push(selectedWorkspace);
              else selectWorkspace(username, home.id);
            }
          } catch {
            if (controller.signal.aborted) return;
            unique.push({ id: saved, name: t("工作区暂不可用"), unavailable: true });
            setSpaces(unique);
            setFailed(true);
            return;
          }
        } else if (!saved) {
          selectWorkspace(username, home.id);
        }
        if (controller.signal.aborted) return;
        setSpaces(unique);
        setFailed(false);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [username, version, t]);

  useEffect(() => {
    onNameChange?.(activeSpace?.name || "");
  }, [activeSpace?.name, onNameChange]);

  useEffect(() => {
    if (!searchOpen) return;
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !switcherRef.current?.contains(event.target)) setSearchOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [searchOpen]);

  function chooseWorkspace(space: WorkspaceOption, restoreFocus = false) {
    if (!space.id || space.unavailable) return;
    setSpaces((current) => [space, ...current.filter((entry) => entry.id !== space.id)]);
    selectWorkspace(username, space.id);
    setSearchOpen(false);
    router.push("/dashboard");
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handlePickerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !searchOpen) return;
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    setSearchOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <div ref={switcherRef} className="workspace-switcher" onKeyDown={handlePickerKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.projectPicker} ${styles.workspaceTrigger}`}
        aria-label={t("切换工作空间")}
        aria-haspopup="listbox"
        aria-expanded={searchOpen}
        aria-controls={searchOpen ? `${dropdownId}-listbox` : undefined}
        title={activeSpace?.name || optionLabel}
        data-workspace-id={activeSpace?.id}
        disabled={!spaces.length}
        onClick={() => setSearchOpen((open) => !open)}
      >
        <span className={styles.projectDot} aria-hidden="true">{(activeSpace?.name || username).slice(0, 1) || "·"}</span>
        <span className={styles.workspaceTriggerName}>{activeSpace?.name || optionLabel}</span>
        <ShellIcon className={styles.icon} name="chevron" />
      </button>
      {searchOpen ? (
        <Suspense fallback={<span className="sr-only" role="status">{t("正在加载…")}</span>}>
          <WorkspaceSearchPanel
            id={dropdownId}
            selectedId={selected}
            onSelect={chooseWorkspace}
          />
        </Suspense>
      ) : null}
      {failed ? <button className="workspace-retry" onClick={() => setVersion((value) => value + 1)}>{t("重试")}</button> : null}
    </div>
  );
}

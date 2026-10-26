"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode, type SelectHTMLAttributes } from "react";
import { useRouter } from "next/navigation";
import { useTranslate } from "./appearance-provider";
import { ShellIcon } from "./shell-icon";
import styles from "./user-shell.module.css";

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

type Space = { id: string; name: string; personal?: boolean };

export function WorkspacePicker({ username, onNameChange }: { username: string; onNameChange?: (name: string) => void }) {
  const t = useTranslate();
  const router = useRouter();
  const selected = useWorkspaceSelection(username);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
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

  function chooseWorkspace(id: string) {
    if (!id) return;
    selectWorkspace(username, id);
    router.push("/dashboard");
  }

  return (
    <div className="workspace-switcher">
      <SidebarSelect
        initial={activeSpace?.name || username}
        value={activeSpace?.id ?? ""}
        aria-label={t("切换工作空间")}
        title={activeSpace?.name}
        disabled={!spaces.length}
        onChange={(event) => chooseWorkspace(event.currentTarget.value)}
      >
        {spaces.length === 0 ? <option value="">{optionLabel}</option> : null}
        {spaces.map((space) => (
          <option key={space.id} value={space.id}>{space.name}</option>
        ))}
      </SidebarSelect>
      {failed ? <button className="workspace-retry" onClick={() => setVersion((value) => value + 1)}>{t("重试")}</button> : null}
    </div>
  );
}

import type { UserProjectNavigationKey } from "@/lib/user-navigation";
import type { TABLER_ICON_PATHS } from "./tabler-icon-data";

const projectNavigationAssets = {
  overview: "layout-dashboard",
  plan: "list-check",
  materials: "folders",
  intelligence: "chart-bar",
  automations: "bolt",
  governance: "shield-check",
} as const satisfies Record<UserProjectNavigationKey, keyof typeof TABLER_ICON_PATHS>;

/**
 * Stable semantic names for shared shell and action icons.  Keep the older
 * shell names available while callers migrate to the broader Tabler subset.
 */
export const SHELL_ICON_ASSETS = {
  ...projectNavigationAssets,
  dashboard: "layout-dashboard",
  ask: "message-circle",
  projects: "folders",
  knowledge: "book-2",
  team: "users",
  help: "help-circle",
  chevron: "chevron-right",
  close: "x",
  menu: "menu-2",
  graph: "affiliate",
  resources: "server",
  credits: "credit-card",
  search: "search",
  circle: "circle",
  logo: "layout-dashboard",
  expand: "arrows-maximize",
  collapse: "arrows-minimize",
  page: "external-link",
  dock: "layout-columns",
  sidebar: "layout-sidebar",
  grid: "layout-dashboard",
  home: "home",
  project: "folders",
  book: "book-2",
  down: "chevron-down",
  back: "arrow-left",
  left: "arrow-left",
  arrow: "arrow-right",
  plus: "plus",
  bell: "bell",
  gear: "settings",
  file: "file-text",
  folder: "folder",
  image: "photo",
  git: "git-branch",
  globe: "world",
  spark: "sparkles",
  chart: "chart-bar",
  check: "check",
  checkcircle: "circle-check",
  clock: "clock",
  alert: "alert-triangle",
  link: "link",
  upload: "upload",
  download: "download",
  more: "dots",
  play: "player-play",
  pause: "player-pause",
  repeat: "refresh",
  shield: "shield-check",
  send: "send",
  message: "message-circle",
  target: "target",
  bolt: "bolt",
  lock: "lock",
  flag: "pin",
  filter: "filter",
  server: "server",
  eye: "eye",
  credit: "credit-card",
  mail: "mail",
  nodes: "affiliate",
  edit: "edit",
  person: "user",
  info: "info-circle",
  key: "key",
  entry: "login",
  github: "brand-github",
  archive: "archive",
  trash: "trash",
  copy: "copy",
  "eye-off": "eye-off",
} as const satisfies Record<string, keyof typeof TABLER_ICON_PATHS>;

export type ShellIconName = keyof typeof SHELL_ICON_ASSETS;
export const SHELL_ICON_NAMES = [
  "dashboard", "ask", "projects", "knowledge", "plan", "materials", "overview",
  "intelligence", "automations", "governance", "team", "help", "chevron", "close",
  "menu", "graph", "resources", "credits", "search",
] as const satisfies readonly ShellIconName[];
export const SHELL_ICON_ALIASES = Object.keys(SHELL_ICON_ASSETS) as ShellIconName[];

export function ShellIcon({ name, className }: Readonly<{ name: ShellIconName; className?: string }>): React.JSX.Element {
  const asset = SHELL_ICON_ASSETS[name];
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      className={["app-icon", className].filter(Boolean).join(" ")}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={name}
      data-icon-asset={asset}
      data-icon-library="tabler"
    >
      <use href={`#aipos-icon-${asset}`} />
    </svg>
  );
}

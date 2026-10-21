import type { SVGProps } from "react";
import type { UserProjectNavigationKey } from "@/lib/user-navigation";

export type ShellIconName = UserProjectNavigationKey | "dashboard" | "ask" | "projects" | "knowledge" | "team" | "help" | "chevron" | "close" | "menu" | "search" | "graph" | "resources" | "credits";
export const SHELL_ICON_NAMES: readonly ShellIconName[] = ["dashboard", "ask", "projects", "knowledge", "plan", "materials", "overview", "intelligence", "automations", "governance", "team", "help", "chevron", "close", "menu", "graph", "resources", "credits", "search"];

type Shape = readonly ["path", SVGProps<SVGPathElement>] | readonly ["circle", SVGProps<SVGCircleElement>] | readonly ["rect", SVGProps<SVGRectElement>];

const shapes: Record<ShellIconName, readonly Shape[]> = {
  dashboard: [["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1 }], ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1 }], ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1 }], ["rect", { x: 14, y: 14, width: 7, height: 7, rx: 1 }]],
  ask: [["path", { d: "M20 11.5a7.5 7.5 0 0 1-8 7.5 8 8 0 0 1-3.4-.75L4 20l1.3-3.3A7.2 7.2 0 0 1 4 12c0-4.4 3.6-8 8-8s8 3.1 8 7.5Z" }], ["path", { d: "M8 11h8M8 14h5" }]],
  projects: [["path", { d: "M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" }], ["path", { d: "M3 9h18" }]],
  knowledge: [["path", { d: "M5 4.5A2.5 2.5 0 0 1 7.5 2H20v19H7.5A2.5 2.5 0 0 1 5 18.5Z" }], ["path", { d: "M5 18.5A2.5 2.5 0 0 1 7.5 16H20M9 6h7M9 9h7" }]],
  plan: [["path", { d: "M8 6h13M8 12h13M8 18h13" }], ["path", { d: "m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" }]],
  materials: [["path", { d: "M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" }], ["path", { d: "M3 9h18" }]],
  overview: [["rect", { x: 3, y: 3, width: 8, height: 8, rx: 1 }], ["rect", { x: 13, y: 3, width: 8, height: 5, rx: 1 }], ["rect", { x: 13, y: 10, width: 8, height: 11, rx: 1 }], ["rect", { x: 3, y: 13, width: 8, height: 8, rx: 1 }]],
  intelligence: [["path", { d: "M3 19h18M5 16l4-5 3 2 6-8" }], ["path", { d: "M15 5h3v3" }]],
  automations: [["path", { d: "m13 2-3 8h7l-6 12 2-9H6l7-11Z" }]],
  governance: [["path", { d: "M12 3 4 7v5c0 5 3.4 8.2 8 10 4.6-1.8 8-5 8-10V7l-8-4Z" }], ["path", { d: "m9 12 2 2 4-4" }]],
  team: [["circle", { cx: 9, cy: 8, r: 3 }], ["path", { d: "M3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6M18 14a4 4 0 0 1 3 4v2" }]],
  help: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M9.7 9a2.4 2.4 0 1 1 3.8 1.9c-.9.6-1.5 1-1.5 2.3M12 17h.01" }]],
  chevron: [["path", { d: "m7 10 5 5 5-5" }]],
  close: [["path", { d: "m6 6 12 12M18 6 6 18" }]],
  menu: [["path", { d: "M4 6h16M4 12h16M4 18h16" }]],
  graph: [["circle", { cx: 5, cy: 5, r: 2 }], ["circle", { cx: 19, cy: 9, r: 2 }], ["circle", { cx: 7, cy: 19, r: 2 }], ["path", { d: "m7 6 10 3M6 7l1 10m2 1 9-8" }]],
  resources: [["rect", { x: 3, y: 4, width: 18, height: 6, rx: 1 }], ["rect", { x: 3, y: 14, width: 18, height: 6, rx: 1 }]],
  credits: [["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ["path", { d: "M3 10h18m-7 5h4" }]],
  search: [["circle", { cx: 10.8, cy: 10.8, r: 6.8 }], ["path", { d: "m16 16 4.5 4.5" }]],
};

export function ShellIcon({ name, className }: Readonly<{ name: ShellIconName; className?: string }>): React.JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{shapes[name].map(renderShape)}</svg>;
}

function renderShape(shape: Shape, key: number): React.JSX.Element {
  if (shape[0] === "path") return <path key={key} {...shape[1]} />;
  if (shape[0] === "circle") return <circle key={key} {...shape[1]} />;
  return <rect key={key} {...shape[1]} />;
}

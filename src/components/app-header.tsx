import Link from "next/link";
import { APP_VERSION } from "@/lib/version";
import { NotificationBell } from "./notification-bell";

type PrimarySection = "dashboard" | "projects" | "settings" | "connections" | "team" | "notifications" | "profile" | "guide";
type ProjectSection = "overview" | "materials" | "assets" | "externalSources" | "repositories" | "world" | "plan" | "automations" | "tools" | "actions" | "control" | "memory" | "memoryQuality" | "intelligence" | "governance" | "guide";

const primaryItems = [
  { key: "dashboard", label: "Dashboard", href: "/dashboard", icon: "grid" },
  { key: "projects", label: "项目", href: "/projects", icon: "folder" },
  { key: "settings", label: "模型设置", href: "/settings", icon: "sliders" },
  { key: "connections", label: "连接器", href: "/connections", icon: "link" },
  { key: "team", label: "团队", href: "/team", icon: "users" },
] as const;

const materialSections: readonly ProjectSection[] = ["materials", "assets", "externalSources", "repositories"];
const intelligenceSections: readonly ProjectSection[] = ["control", "memory", "memoryQuality", "intelligence"];
const managementSections: readonly ProjectSection[] = ["world", "plan", "automations", "tools", "actions", "governance"];

export function AppHeader({
  username,
  active,
  projectId,
  projectSection,
}: {
  username: string;
  active: PrimarySection;
  projectId?: string;
  projectSection?: ProjectSection;
}) {
  const initial = username.slice(0, 1).toUpperCase();
  const guideActive = active === "guide";
  const guideHref = projectId ? `/guide?projectId=${encodeURIComponent(projectId)}` : "/guide";

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-3.5 sm:px-8 lg:px-10">
        <Link href="/dashboard" className="group flex shrink-0 items-center gap-3" aria-label="AI Project OS Dashboard">
          <span className="relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-slate-950 text-xs font-bold text-white shadow-lg shadow-slate-950/15">
            <span className="absolute -right-2 -top-2 h-5 w-5 rounded-full bg-indigo-500 blur-sm" />
            <span className="relative">OS</span>
          </span>
          <span className="hidden sm:block">
            <span className="block text-sm font-bold tracking-[0.14em] text-slate-950">AI PROJECT OS</span>
            <span className="mt-0.5 block text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500">内部开发版 · {APP_VERSION}</span>
          </span>
        </Link>

        <nav className="order-3 flex w-full flex-wrap items-center gap-1 rounded-2xl bg-slate-100/80 p-1 xl:order-2 xl:w-auto" aria-label="全局导航">
          {primaryItems.map((item) => {
            const isActive = item.key === active;
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${isActive ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:bg-white/70 hover:text-slate-900"}`}
              >
                <NavIcon name={item.icon} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="order-2 flex items-center gap-2 xl:order-3">
          <NotificationBell active={active === "notifications"} />
          <Link
            href={guideHref}
            aria-label="打开帮助与使用指南"
            aria-current={guideActive ? "page" : undefined}
            title="帮助与使用指南"
            className={`flex h-11 items-center gap-2 rounded-full border px-3 transition ${guideActive ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"}`}
          >
            <NavIcon name="help" />
            <span className="hidden text-xs font-semibold lg:block">帮助</span>
          </Link>
          <Link
            href="/profile"
            aria-label={`个人中心：${username}`}
            aria-current={active === "profile" ? "page" : undefined}
            className={`flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3 transition ${active === "profile" ? "border-indigo-200 bg-indigo-50" : "border-slate-200 bg-white hover:border-indigo-200"}`}
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-xs font-bold text-white shadow-sm">{initial}</span>
            <span className="hidden max-w-28 truncate text-xs font-semibold text-slate-700 sm:block">{username}</span>
          </Link>
        </div>
      </div>

      {projectId ? (
        <div className="border-t border-slate-100 bg-slate-50/90">
          <div className="mx-auto max-w-7xl px-5 py-2.5 sm:px-8 lg:px-10">
            <nav className="flex w-full flex-wrap items-center gap-1 rounded-xl border border-slate-200/80 bg-white/70 p-1 shadow-sm shadow-slate-950/[0.02]" aria-label="项目导航">
              <Link
                href="/projects"
                className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 hover:bg-indigo-50 hover:text-indigo-700"
              >
                <NavIcon name="arrow-left" />
                项目列表
              </Link>
              <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-slate-200 sm:block" />
              <Link
                href={`/projects/${projectId}`}
                aria-current={projectSection === "overview" ? "page" : undefined}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${projectSection === "overview" ? "bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:bg-white hover:text-slate-950"}`}
              >
                <NavIcon name="home" />
                概览
              </Link>
              <Link
                href={`/projects/${projectId}/materials`}
                aria-current={projectSection && materialSections.includes(projectSection) ? "page" : undefined}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${projectSection && materialSections.includes(projectSection) ? "bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:bg-white hover:text-slate-950"}`}
              >
                <NavIcon name="folder" />
                项目资料
              </Link>
              <Link
                href={`/projects/${projectId}/intelligence`}
                aria-current={projectSection && intelligenceSections.includes(projectSection) ? "page" : undefined}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${projectSection && intelligenceSections.includes(projectSection) ? "bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:bg-white hover:text-slate-950"}`}
              >
                <NavIcon name="sparkles" />
                AI 工作台
              </Link>
              <Link
                href={`/projects/${projectId}/governance`}
                aria-current={projectSection && managementSections.includes(projectSection) ? "page" : undefined}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${projectSection && managementSections.includes(projectSection) ? "bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:bg-white hover:text-slate-950"}`}
              >
                <NavIcon name="sliders" />
                管理
              </Link>
            </nav>
          </div>
        </div>
      ) : null}
    </header>
  );
}

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
    folder: <path d="M3 7.5h7l2-2h9v12.75A2.75 2.75 0 0 1 18.25 21H5.75A2.75 2.75 0 0 1 3 18.25V7.5Z" />,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.8 9.2a2.4 2.4 0 1 1 3.5 2.15c-.8.4-1.3.9-1.3 1.9" /><path d="M12 17h.01" /></>,
    sliders: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.15 1.15" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.15-1.15" /></>,
    "arrow-left": <><path d="m15 18-6-6 6-6" /><path d="M9 12h10" /></>,
    home: <><path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M9 20v-6h6v6" /></>,
    book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    sparkles: <><path d="m12 3 1.15 3.1L16 7.25l-2.85 1.15L12 11.5 10.85 8.4 8 7.25l2.85-1.15L12 3Z" /><path d="m18.5 13 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" /><path d="m5.5 12 .95 2.55L9 15.5l-2.55.95L5.5 19l-.95-2.55L2 15.5l2.55-.95L5.5 12Z" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

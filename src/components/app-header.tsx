import Link from "next/link";
import { APP_VERSION } from "@/lib/version";

type PrimarySection = "dashboard" | "projects" | "settings" | "connections" | "team" | "notifications" | "profile" | "guide";
type ProjectSection = "overview" | "assets" | "externalSources" | "repositories" | "world" | "plan" | "automations" | "tools" | "actions" | "control" | "memory" | "memoryQuality" | "intelligence" | "governance";

const primaryItems = [
  { key: "dashboard", label: "Dashboard", href: "/dashboard", icon: "grid" },
  { key: "projects", label: "项目", href: "/projects", icon: "folder" },
  { key: "settings", label: "模型设置", href: "/settings", icon: "sliders" },
  { key: "connections", label: "连接器", href: "/connections", icon: "link" },
  { key: "team", label: "团队", href: "/team", icon: "users" },
] as const;

const projectItems = [
  { key: "overview", label: "资料与条目", suffix: "" },
  { key: "assets", label: "文件资料", suffix: "/assets" },
  { key: "externalSources", label: "外部资料", suffix: "/external-sources" },
  { key: "repositories", label: "代码仓库", suffix: "/repositories" },
  { key: "world", label: "项目状态", suffix: "/world" },
  { key: "plan", label: "项目计划", suffix: "/plan" },
  { key: "automations", label: "自动化", suffix: "/automations" },
  { key: "tools", label: "工具权限", suffix: "/tools" },
  { key: "actions", label: "动作与审批", suffix: "/actions" },
  { key: "control", label: "智能控制台", suffix: "/control" },
  { key: "memory", label: "智能记忆", suffix: "/memory" },
  { key: "memoryQuality", label: "记忆质量", suffix: "/memory-quality" },
  { key: "intelligence", label: "项目智能体", suffix: "/intelligence" },
  { key: "governance", label: "治理与审核", suffix: "/governance" },
] as const;

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
            <span className="mt-0.5 block text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">Project intelligence · V{APP_VERSION}</span>
          </span>
        </Link>

        <nav className="order-3 flex w-full items-center gap-1 overflow-x-auto rounded-2xl bg-slate-100/80 p-1 md:order-2 md:w-auto" aria-label="全局导航">
          {primaryItems.map((item) => {
            const isActive = item.key === active;
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition ${isActive ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:bg-white/70 hover:text-slate-900"}`}
              >
                <NavIcon name={item.icon} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="order-2 flex items-center gap-2 md:order-3">
          <Link
            href="/notifications"
            aria-label="打开通知中心"
            aria-current={active === "notifications" ? "page" : undefined}
            title="通知中心"
            className={`flex h-11 w-11 items-center justify-center rounded-full border transition ${active === "notifications" ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-500 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"}`}
          >
            <NavIcon name="bell" />
          </Link>
          <Link
            href="/guide"
            aria-label="打开帮助与使用指南"
            aria-current={guideActive ? "page" : undefined}
            title="帮助与使用指南"
            className={`flex h-11 items-center gap-2 rounded-full border px-3 transition ${guideActive ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-500 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"}`}
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
        <div className="border-t border-slate-100 bg-slate-50/80">
          <nav className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-5 py-2 sm:px-8 lg:px-10" aria-label="项目导航">
            <span className="mr-2 shrink-0 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">当前项目</span>
            {projectItems.map((item) => {
              const isActive = item.key === projectSection;
              return (
                <Link
                  key={item.key}
                  href={`/projects/${projectId}${item.suffix}`}
                  aria-current={isActive ? "page" : undefined}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${isActive ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-white hover:text-slate-900"}`}
                >
                  {item.label}
                </Link>
              );
            })}
            <Link href="/guide#project-data" className="ml-auto shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-indigo-600 hover:bg-indigo-50">查看指引</Link>
          </nav>
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
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

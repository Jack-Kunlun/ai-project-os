import Link from "next/link";

/** The pages that belong to the account-owned personal workspace. */
export type PersonalWorkspaceNavItem = "overview" | "knowledge" | "configuration" | "models" | "git" | "mcp";

type PersonalWorkspaceNavProps = Readonly<{
  /** Marks the current workspace page so keyboard and visual state stay aligned. */
  active: PersonalWorkspaceNavItem;
}>;

const items: readonly Readonly<{ key: PersonalWorkspaceNavItem; label: string; href: string }>[] = [
  { key: "overview", label: "总览", href: "/personal" },
  { key: "knowledge", label: "知识库", href: "/personal/knowledge" },
  { key: "configuration", label: "配置", href: "/personal/configuration" },
  { key: "models", label: "我的模型", href: "/personal/models" },
  { key: "git", label: "Git 连接", href: "/personal/connections/git" },
  { key: "mcp", label: "MCP 连接", href: "/personal/connections/mcp" },
];

/**
 * Keep personal resources under one workspace navigation. Project pages only
 * consume these resources through their own delegation and selection flows.
 */
export function PersonalWorkspaceNav({ active }: PersonalWorkspaceNavProps): React.JSX.Element {
  return (
    <nav className="border-b border-slate-200/80 bg-white/90" aria-label="个人工作区导航">
      <div className="mx-auto max-w-7xl px-5 sm:px-8 lg:px-10">
        <div className="flex flex-wrap items-center gap-1 py-2">
          {items.map((item) => {
            const isActive = item.key === active;
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`rounded-xl px-3.5 py-2 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${isActive ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"}`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

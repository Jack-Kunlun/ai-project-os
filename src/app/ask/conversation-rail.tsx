"use client";

import { useId, useRef, useState } from "react";
import { UiErrorText } from "@/components/ui-error-text";
import { ShellIcon } from "@/components/shell-icon";
import { useTranslate, UiText, useAppearance } from "@/components/appearance-provider";
import type { TokenUsageSummary } from "@/lib/token-usage";
import styles from "./ask-client.module.css";
import ui from "@/components/workspace-ui.module.css";

export type ConversationSummary = { id: string; title: string; updatedAt: string; turnCount: number; ranges?: string[]; pinned?: boolean; archived?: boolean; deleted?: boolean; presentationRevision?: number; usage?: TokenUsageSummary };
export type ConversationView = "active" | "archived" | "deleted";
export type PresentationPatch = { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean };
function ConversationActions({ item, disabled, update, rename }: { item: ConversationSummary; disabled: boolean; update: (patch: PresentationPatch) => void; rename: () => void }) {
  const t = useTranslate(), id = useId(), popover = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  function act(action: () => void) { popover.current?.hidePopover(); action(); }
  return <>
    <button className={styles.moreButton} type="button" title={t("会话操作")} aria-label={`${t("会话操作")} · ${item.title}`} aria-expanded={expanded} popoverTarget={id} disabled={disabled} onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      setPosition({ top: Math.min(rect.bottom + 6, window.innerHeight - 220), left: Math.max(8, Math.min(rect.right - 180, window.innerWidth - 188)) });
    }}><ShellIcon name="more" /></button>
    <div id={id} ref={popover} popover="auto" className={styles.conversationPopover} style={position} onToggle={event => setExpanded(event.newState === "open")}>
      {item.deleted ? <button disabled={disabled} onClick={() => act(() => update({ deleted: false }))}><ShellIcon name="repeat"/><UiText text="恢复会话"/></button> : <>
        <button disabled={disabled} onClick={() => act(() => update({ pinned: !item.pinned }))}><ShellIcon name="flag"/><UiText text={item.pinned ? "取消置顶" : "置顶会话"}/></button>
        <button disabled={disabled} onClick={() => act(rename)}><ShellIcon name="edit"/><UiText text="重命名会话"/></button>
        <button disabled={disabled} onClick={() => act(() => update({ archived: !item.archived }))}><ShellIcon name="archive"/><UiText text={item.archived ? "取消归档" : "归档会话"}/></button>
        <button disabled={disabled} onClick={() => act(() => update({ deleted: true }))}><ShellIcon name="trash"/><UiText text="移至回收站"/></button>
      </>}
    </div>
  </>;
}
export function ConversationRail(props: {
  collapsed: boolean; setCollapsed: (value: boolean) => void; busy: boolean; currentId?: string;
  items: ConversationSummary[]; view: ConversationView; setView: (value: ConversationView) => void;
  query: string; setQuery: (value: string) => void; loading: boolean; error: string | null;
  page: number; totalPages: number; setPage: (value: number) => void;
  refresh: () => void; create: () => void; open: (id: string) => void;
  update: (item: ConversationSummary, patch: PresentationPatch) => void; rename: (item: ConversationSummary) => void;
}) {
  const t = useTranslate(), { language } = useAppearance();
  return <aside className={styles.conversationRail} data-collapsed={props.collapsed} aria-label={t("最近会话")}>
    <div className={styles.railHeading}>
      {!props.collapsed ? <strong><UiText text="最近会话"/></strong> : null}
      <button className={styles.railIcon} type="button" onClick={() => props.setCollapsed(!props.collapsed)} aria-label={t(props.collapsed ? "展开最近会话" : "收起最近会话")} title={t(props.collapsed ? "展开最近会话" : "收起最近会话")} aria-expanded={!props.collapsed}><ShellIcon name="sidebar"/></button>
    </div>
    <button className={props.collapsed ? styles.railIcon : styles.newConversation} onClick={props.create} disabled={props.busy} aria-label={t("新建会话")} title={t("新建会话")}><ShellIcon name="plus"/>{!props.collapsed ? <span><UiText text="新建会话"/></span> : null}</button>
    {!props.collapsed ? <>
      <label className={ui.field}><span className={styles.visuallyHidden}><UiText text="会话列表"/></span><select aria-label={t("会话列表")} value={props.view} onChange={e => props.setView(e.target.value as ConversationView)}><option value="active"><UiText text="最近会话"/></option><option value="archived"><UiText text="已归档"/></option><option value="deleted"><UiText text="回收站"/></option></select></label>
      <input className={ui.search} aria-label={t("搜索历史会话")} placeholder={t("搜索会话")} value={props.query} onChange={e => props.setQuery(e.target.value)}/>
      {props.error ? <p className={ui.error} role="alert"><UiErrorText text={props.error} /><button className={ui.link} onClick={props.refresh}><UiText text="重新加载"/></button></p> : null}
      <div className={styles.railList} aria-busy={props.loading}>
        {props.loading && !props.items.length ? <p role="status"><UiText text="正在查找会话…"/></p> : props.items.length ? props.items.map(item => <div className={styles.railItem} key={item.id} data-current={props.currentId === item.id}>
          <button className={styles.railMain} disabled={props.busy} aria-current={props.currentId === item.id ? "true" : undefined} onClick={() => props.open(item.id)}>
            <span className={styles.railTitle}>{item.pinned ? <ShellIcon name="flag" className={styles.iconSmall}/> : null}{item.title}</span>
            <small>{language === "en" ? `${item.turnCount} ${item.turnCount === 1 ? "turn" : "turns"}` : `${item.turnCount} 轮问答`}</small>
          </button>
          <ConversationActions item={item} disabled={props.busy} update={patch => props.update(item, patch)} rename={() => props.rename(item)}/>
        </div>) : <p className={styles.railEmpty}><UiText text="暂无匹配会话"/></p>}
      </div>
      {props.totalPages > 1 ? <div className={styles.railPagination}><button className={styles.railIcon} disabled={props.loading || props.page <= 1} onClick={() => props.setPage(props.page - 1)} aria-label={t("上一页")}><ShellIcon name="chevron" className={styles.chevronPrevious}/></button><span>{props.page} / {props.totalPages}</span><button className={styles.railIcon} disabled={props.loading || props.page >= props.totalPages} onClick={() => props.setPage(props.page + 1)} aria-label={t("下一页")}><ShellIcon name="chevron"/></button></div> : null}
    </> : null}
  </aside>;
}

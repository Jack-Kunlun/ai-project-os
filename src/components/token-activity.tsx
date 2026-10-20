"use client";

import { useMemo, useState } from "react";
import { UiText, useAppearance } from "@/components/appearance-provider";
import token from "./token-activity.module.css";

type DailyPoint = Readonly<{ date: string; settledRawTokens: number; rawTokenCoverageComplete: boolean }>;
type Mode = "daily" | "weekly" | "cumulative";
const modes: ReadonlyArray<readonly [Mode, string]> = [["daily", "每日"], ["weekly", "每周"], ["cumulative", "累计"]];
type ActiveCell = Readonly<{ date: string; value: number; complete: boolean; x: number; y: number; below: boolean }>;

function utcDay(date: string): Date { return new Date(`${date}T00:00:00Z`); }
function dateKey(date: Date): string { return date.toISOString().slice(0, 10); }

export function TokenActivity({ daily }: { daily: readonly DailyPoint[] }) {
  const { language, t } = useAppearance();
  const [mode, setMode] = useState<Mode>("daily");
  const compact=daily.length<=7;
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const modeLabel = t(modes.find(([value]) => value === mode)?.[1] ?? "每日");
  const currentFocusedDate = focusedDate && daily.some((point) => point.date === focusedDate) ? focusedDate : daily.at(-1)?.date;
  const { weeks, maxValue } = useMemo(() => {
    if (daily.length === 0) return { weeks: [], maxValue: 0 };
    const byDate = new Map(daily.map((point) => [point.date, point]));
    const first = utcDay(daily[0].date);
    first.setUTCDate(first.getUTCDate() - first.getUTCDay());
    const last = utcDay(daily[daily.length - 1].date);
    const result: Array<Array<{ date: string; point: DailyPoint | null; value: number }>> = [];
    let cumulative = 0;
    for (let cursor = new Date(first); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
      const week = Array.from({ length: 7 }, (_, day) => {
        const date = new Date(cursor);
        date.setUTCDate(date.getUTCDate() + day);
        const key = dateKey(date);
        const point = byDate.get(key) ?? null;
        if (point) cumulative += point.settledRawTokens;
        return { date: key, point, value: mode === "cumulative" ? cumulative : point?.settledRawTokens ?? 0 };
      });
      if (mode === "weekly") {
        const weeklyTotal = week.reduce((sum, cell) => sum + (cell.point?.settledRawTokens ?? 0), 0);
        for (const cell of week) cell.value = weeklyTotal;
      }
      result.push(week);
    }
    return { weeks: result, maxValue: Math.max(0, ...result.flatMap((week) => week.filter((cell) => cell.point).map((cell) => cell.value))) };
  }, [daily, mode]);
  const activePoint = activeCell ? weeks.flat().find((cell) => cell.date === activeCell.date) : null;
  const visibleActiveCell = activeCell && activePoint?.point ? { ...activeCell, value: activePoint.value, complete: activePoint.point.rawTokenCoverageComplete } : null;

  function tone(value: number): string {
    if (value <= 0 || maxValue <= 0) return token.level0;
    const fraction = value / maxValue;
    return fraction < 0.25 ? token.level1 : fraction < 0.5 ? token.level2 : fraction < 0.75 ? token.level3 : token.level4;
  }

  function showCell(cell: { date: string; point: DailyPoint | null; value: number }, element: HTMLElement): void {
    if (!cell.point) return;
    const bounds = element.getBoundingClientRect();
    const below = bounds.top < 90;
    setActiveCell({
      date: cell.date,
      value: cell.value,
      complete: cell.point.rawTokenCoverageComplete,
      x: Math.max(118, Math.min(window.innerWidth - 118, bounds.left + bounds.width / 2)),
      y: below ? bounds.bottom + 8 : bounds.top - 8,
      below,
    });
  }

  function showFocusedDate(date: string, grid: HTMLElement): void {
    const cell = weeks.flat().find((entry) => entry.date === date);
    const element = grid.querySelector<HTMLElement>(`[data-token-date="${date}"]`);
    if (cell && element) showCell(cell, element);
  }

  function moveFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
    const offset = event.key === "ArrowLeft" ? (compact?-1:-7) : event.key === "ArrowRight" ? (compact?1:7) : event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : null;
    if (offset === null && event.key !== "Home" && event.key !== "End") {
      if (event.key === "Escape") setActiveCell(null);
      return;
    }
    event.preventDefault();
    const currentIndex = currentFocusedDate ? daily.findIndex((point) => point.date === currentFocusedDate) : -1;
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? daily.length - 1 : currentIndex + offset!;
    const next = daily[nextIndex];
    if (!next) return;
    setFocusedDate(next.date);
    showFocusedDate(next.date, event.currentTarget);
  }

  return <div className={token.root}>
    <div className={token.heading}>
      <h3 className="text-sm font-semibold"><UiText text="Token 活动" /></h3>
      <div className={token.modes} aria-label={t("Token 活动统计方式")}>{modes.map(([value, label]) => <button key={value} type="button" onClick={() => { setActiveCell(null); setMode(value); }} aria-pressed={mode === value} className={token.mode}><UiText text={label} /></button>)}</div>
    </div>
    <div className={token.scroll} onScroll={() => setActiveCell(null)}>
      <div data-token-grid className={`${token.grid} ${compact?token.compact:""}`} style={{ gridTemplateColumns: compact&&daily.length?`repeat(${daily.length}, minmax(0, 1fr))`:weeks.length ? `repeat(${weeks.length}, minmax(18px, 1fr))` : undefined, minWidth: compact?0:weeks.length * 18, maxWidth: compact?undefined:weeks.length < 26 ? weeks.length * 24 : undefined }} role="group" tabIndex={daily.length ? 0 : -1} aria-label={`${t("Token 活动热力图")} · ${daily.length} ${t("天")} · ${modeLabel} ${t("统计")} · ${t("方向键切换日期")}${daily.some((point) => !point.rawTokenCoverageComplete) ? ` · ${t("部分历史用量未核实")}` : ""}`} onPointerLeave={() => setActiveCell(null)} onFocus={(event) => { if (currentFocusedDate) { setFocusedDate(currentFocusedDate); showFocusedDate(currentFocusedDate, event.currentTarget); } }} onBlur={() => setActiveCell(null)} onKeyDown={moveFocus}>
        {weeks.map((week, index) => <div key={week[0].date} className={token.week}>
          {week.map((cell) => cell.point ? <span key={cell.date} data-token-date={cell.date} aria-hidden="true" className={token.cell} data-active={visibleActiveCell?.date===cell.date||undefined} onPointerEnter={(event) => showCell(cell, event.currentTarget)}><span className={`${token.square} ${tone(cell.value)}`} />{compact?<small>{cell.date.slice(5).replace("-","/")}</small>:null}</span> : <span key={cell.date} aria-hidden="true" className={token.blank} />)}
          <span aria-hidden="true" className={token.month}>{index === 0 || week.some((cell) => cell.point?.date.endsWith("-01")) ? new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { month: "short", timeZone: "UTC" }).format(utcDay(week.find((cell) => cell.point?.date.endsWith("-01"))?.date ?? week.find((cell) => cell.point)?.date ?? "2026-01-01")) : ""}</span>
        </div>)}
      </div>
    </div>
    {visibleActiveCell ? <div role="tooltip" className={token.tooltip} style={{ left: visibleActiveCell.x, top: visibleActiveCell.y, transform: `translate(-50%, ${visibleActiveCell.below ? "0" : "-100%"})` }}><span className="block font-semibold">{visibleActiveCell.date}</span><span className="mt-1 block">{modeLabel} {t("已结算")} {visibleActiveCell.value.toLocaleString(language === "en" ? "en-US" : "zh-CN")} Token</span>{visibleActiveCell.complete ? null : <span className="mt-1 block">{t("部分历史原始 Token 未核实")}</span>}</div> : null}
    <span className="sr-only" aria-live="polite">{focusedDate && visibleActiveCell?.date === focusedDate ? `${focusedDate} · ${modeLabel} ${t("已结算")} ${visibleActiveCell.value.toLocaleString(language === "en" ? "en-US" : "zh-CN")} Token${visibleActiveCell.complete ? "" : ` · ${t("部分历史原始 Token 未核实")}`}` : ""}</span>
    <p className={token.hint}>{t("按已结算且核实的模型原始 Token 数着色；移入日期格立即查看数值，键盘聚焦热图后可用方向键切换日期。")}{daily.some((point) => !point.rawTokenCoverageComplete) ? ` ${t("部分历史记录缺少原始 Token，图中数值不含这部分用量。")}` : ""}</p>
  </div>;
}

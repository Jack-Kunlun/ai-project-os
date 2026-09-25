"use client";

import { useMemo, useState } from "react";

type DailyPoint = Readonly<{ date: string; settledRawTokens: number; rawTokenCoverageComplete: boolean }>;
type Mode = "daily" | "weekly" | "cumulative";
const modes: ReadonlyArray<readonly [Mode, string]> = [["daily", "每日"], ["weekly", "每周"], ["cumulative", "累计"]];
type ActiveCell = Readonly<{ date: string; value: number; complete: boolean; x: number; y: number; below: boolean }>;

function utcDay(date: string): Date { return new Date(`${date}T00:00:00Z`); }
function dateKey(date: Date): string { return date.toISOString().slice(0, 10); }

export function TokenActivity({ daily }: { daily: readonly DailyPoint[] }) {
  const [mode, setMode] = useState<Mode>("daily");
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const modeLabel = modes.find(([value]) => value === mode)?.[1] ?? "每日";
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
    if (value <= 0 || maxValue <= 0) return "bg-white/15";
    const fraction = value / maxValue;
    return fraction < 0.25 ? "bg-sky-200/70" : fraction < 0.5 ? "bg-indigo-200" : fraction < 0.75 ? "bg-violet-200" : "bg-fuchsia-100";
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
    const offset = event.key === "ArrowLeft" ? -7 : event.key === "ArrowRight" ? 7 : event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : null;
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

  return <div className="rounded-2xl px-5 py-5 text-white shadow-sm sm:px-6" style={{ backgroundImage: "radial-gradient(circle at 88% 8%, rgba(198, 165, 255, .18), transparent 42%), linear-gradient(120deg, #354d86 0%, #50438d 52%, #60418a 100%)" }}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">Token 活动</h3>
      <div className="flex items-center gap-1 rounded-lg bg-white/10 p-1" aria-label="Token 活动统计方式">{modes.map(([value, label]) => <button key={value} type="button" onClick={() => { setActiveCell(null); setMode(value); }} aria-pressed={mode === value} className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${mode === value ? "bg-white text-slate-900" : "text-indigo-100 hover:bg-white/10 hover:text-white"}`}>{label}</button>)}</div>
    </div>
    <div className="mt-4 overflow-x-auto pb-1 app-scrollbar-dark" onScroll={() => setActiveCell(null)}>
      <div data-token-grid className="mx-auto grid w-full focus-visible:outline-2 focus-visible:outline-white" style={{ gridTemplateColumns: weeks.length ? `repeat(${weeks.length}, minmax(18px, 1fr))` : undefined, minWidth: weeks.length * 18, maxWidth: weeks.length < 26 ? weeks.length * 24 : undefined }} role="group" tabIndex={daily.length ? 0 : -1} aria-label={`Token 活动热力图，${daily.length} 天，${modeLabel}统计。方向键切换日期${daily.some((point) => !point.rawTokenCoverageComplete) ? "，部分历史用量未核实" : ""}`} onPointerLeave={() => setActiveCell(null)} onFocus={(event) => { if (currentFocusedDate) { setFocusedDate(currentFocusedDate); showFocusedDate(currentFocusedDate, event.currentTarget); } }} onBlur={() => setActiveCell(null)} onKeyDown={moveFocus}>
        {weeks.map((week, index) => <div key={week[0].date} className="flex min-w-0 flex-col">
          {week.map((cell) => cell.point ? <span key={cell.date} data-token-date={cell.date} aria-hidden="true" className="aspect-square w-full p-0.5" onPointerEnter={(event) => showCell(cell, event.currentTarget)}><span className={`block h-full w-full rounded-[3px] ${tone(cell.value)}`} /></span> : <span key={cell.date} aria-hidden="true" className="aspect-square w-full" />)}
          <span aria-hidden="true" className="h-4 w-full whitespace-nowrap pt-1 text-[10px] text-indigo-100">{index === 0 || week.some((cell) => cell.point?.date.endsWith("-01")) ? `${Number(week.find((cell) => cell.point?.date.endsWith("-01"))?.date.slice(5, 7) ?? week.find((cell) => cell.point)?.date.slice(5, 7) ?? "")}月` : ""}</span>
        </div>)}
      </div>
    </div>
    {visibleActiveCell ? <div role="tooltip" className="pointer-events-none fixed z-50 w-[220px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 shadow-xl" style={{ left: visibleActiveCell.x, top: visibleActiveCell.y, transform: `translate(-50%, ${visibleActiveCell.below ? "0" : "-100%"})` }}><span className="block font-semibold">{visibleActiveCell.date}</span><span className="mt-1 block">{modeLabel}已结算 {visibleActiveCell.value.toLocaleString("zh-CN")} Token</span>{visibleActiveCell.complete ? null : <span className="mt-1 block text-amber-700">部分历史原始 Token 未核实</span>}</div> : null}
    <span className="sr-only" aria-live="polite">{focusedDate && visibleActiveCell?.date === focusedDate ? `${focusedDate}，${modeLabel}已结算 ${visibleActiveCell.value.toLocaleString("zh-CN")} Token${visibleActiveCell.complete ? "" : "，部分历史原始 Token 未核实"}` : ""}</span>
    <p className="mt-3 text-xs text-indigo-100">按已结算且核实的模型原始 Token 数着色；移入日期格立即查看数值，键盘聚焦热图后可用方向键切换日期。{daily.some((point) => !point.rawTokenCoverageComplete) ? "部分历史记录缺少原始 Token，图中数值不含这部分用量。" : ""}</p>
  </div>;
}

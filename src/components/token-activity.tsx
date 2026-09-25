"use client";

import { useMemo, useState } from "react";

type DailyPoint = Readonly<{ date: string; settledRawTokens: number; rawTokenCoverageComplete: boolean }>;
type Mode = "daily" | "weekly" | "cumulative";
const modes: ReadonlyArray<readonly [Mode, string]> = [["daily", "每日"], ["weekly", "每周"], ["cumulative", "累计"]];

function utcDay(date: string): Date { return new Date(`${date}T00:00:00Z`); }
function dateKey(date: Date): string { return date.toISOString().slice(0, 10); }

export function TokenActivity({ daily }: { daily: readonly DailyPoint[] }) {
  const [mode, setMode] = useState<Mode>("daily");
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

  function tone(value: number): string {
    if (value <= 0 || maxValue <= 0) return "bg-white/15";
    const fraction = value / maxValue;
    return fraction < 0.25 ? "bg-sky-200/65" : fraction < 0.5 ? "bg-indigo-200" : fraction < 0.75 ? "bg-violet-200" : "bg-fuchsia-100";
  }

  return <div className="rounded-2xl px-5 py-5 text-white shadow-sm sm:px-6" style={{ backgroundImage: "radial-gradient(circle at 88% 8%, rgba(198, 165, 255, .34), transparent 42%), linear-gradient(120deg, #30477e 0%, #454085 52%, #694596 100%)" }}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">Token 活动</h3>
      <div className="flex items-center gap-1 rounded-lg bg-white/10 p-1" aria-label="Token 活动统计方式">{modes.map(([value, label]) => <button key={value} type="button" onClick={() => setMode(value)} aria-pressed={mode === value} className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${mode === value ? "bg-white/20 text-white" : "text-indigo-100 hover:bg-white/10 hover:text-white"}`}>{label}</button>)}</div>
    </div>
    <div className="mt-4 overflow-x-auto pb-1 app-scrollbar-dark">
      <div className="mx-auto grid w-full gap-[3px]" style={{ gridTemplateColumns: weeks.length ? `repeat(${weeks.length}, minmax(14px, 1fr))` : undefined, minWidth: weeks.length * 17, maxWidth: weeks.length < 26 ? weeks.length * 24 : undefined }} role="img" aria-label={`Token 活动热力图，${daily.length} 天，${modes.find(([value]) => value === mode)?.[1]}统计${daily.some((point) => !point.rawTokenCoverageComplete) ? "，部分历史用量未核实" : ""}`}>
        {weeks.map((week, index) => <div key={week[0].date} className="flex min-w-0 flex-col gap-[3px]">
          {week.map((cell) => <span key={cell.date} aria-hidden="true" title={cell.point ? `${cell.date} · ${modes.find(([value]) => value === mode)?.[1]}已结算 ${cell.value.toLocaleString("zh-CN")} Token${cell.point.rawTokenCoverageComplete ? "" : " · 部分历史原始 Token 未核实"}` : undefined} className={`aspect-square w-full rounded-[3px] ${cell.point ? tone(cell.value) : "opacity-0"}`} />)}
          <span aria-hidden="true" className="h-4 w-full whitespace-nowrap pt-1 text-[10px] text-indigo-100">{index === 0 || week.some((cell) => cell.point?.date.endsWith("-01")) ? `${Number(week.find((cell) => cell.point?.date.endsWith("-01"))?.date.slice(5, 7) ?? week.find((cell) => cell.point)?.date.slice(5, 7) ?? "")}月` : ""}</span>
        </div>)}
      </div>
    </div>
    <p className="mt-3 text-xs text-indigo-100">按已结算且核实的模型原始 Token 数着色；悬停可查看具体数值。{daily.some((point) => !point.rawTokenCoverageComplete) ? "部分历史记录缺少原始 Token，图中数值不含这部分用量。" : ""}</p>
  </div>;
}

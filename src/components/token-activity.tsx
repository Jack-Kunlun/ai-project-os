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
    if (value <= 0 || maxValue <= 0) return "bg-white/10";
    const fraction = value / maxValue;
    return fraction < 0.25 ? "bg-blue-950" : fraction < 0.5 ? "bg-blue-800" : fraction < 0.75 ? "bg-blue-600" : "bg-blue-400";
  }

  return <div className="rounded-2xl bg-[#1c1d21] px-5 py-5 text-white sm:px-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">Token 活动</h3>
      <div className="flex items-center gap-3" aria-label="Token 活动统计方式">{modes.map(([value, label]) => <button key={value} type="button" onClick={() => setMode(value)} aria-pressed={mode === value} className={`text-xs font-medium transition ${mode === value ? "text-white" : "text-slate-400 hover:text-white"}`}>{label}</button>)}</div>
    </div>
    <div className="mt-4 overflow-x-auto pb-1 app-scrollbar-dark">
      <div className="flex min-w-max gap-[3px]" role="img" aria-label={`Token 活动热力图，${daily.length} 天，${modes.find(([value]) => value === mode)?.[1]}统计${daily.some((point) => !point.rawTokenCoverageComplete) ? "，部分历史用量未核实" : ""}`}>
        {weeks.map((week, index) => <div key={week[0].date} className="flex flex-col gap-[3px]">
          {week.map((cell) => <span key={cell.date} aria-hidden="true" title={cell.point ? `${cell.date} · ${modes.find(([value]) => value === mode)?.[1]}已结算 ${cell.value.toLocaleString("zh-CN")} Token${cell.point.rawTokenCoverageComplete ? "" : " · 部分历史原始 Token 未核实"}` : undefined} className={`h-2.5 w-2.5 rounded-[2px] ${cell.point ? tone(cell.value) : "opacity-0"}`} />)}
          <span aria-hidden="true" className="h-4 w-2.5 whitespace-nowrap pt-1 text-[10px] text-slate-400">{index === 0 || week.some((cell) => cell.point?.date.endsWith("-01")) ? `${Number(week.find((cell) => cell.point?.date.endsWith("-01"))?.date.slice(5, 7) ?? week.find((cell) => cell.point)?.date.slice(5, 7) ?? "")}月` : ""}</span>
        </div>)}
      </div>
    </div>
    <p className="mt-3 text-xs text-slate-400">按已结算且核实的模型原始 Token 数着色；悬停可查看具体数值。{daily.some((point) => !point.rawTokenCoverageComplete) ? "部分历史记录缺少原始 Token，图中数值不含这部分用量。" : ""}</p>
  </div>;
}

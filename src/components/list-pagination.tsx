"use client";

export function ListPagination({
  page,
  totalPages,
  total,
  onPageChange,
  disabled = false,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
}) {
  if (total === 0) return null;

  return (
    <nav className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5" aria-label="列表分页">
      <p className="text-xs text-slate-400">共 {total} 条 · 第 {page} / {totalPages} 页</p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onPageChange(page - 1)} disabled={disabled || page <= 1} className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">上一页</button>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={disabled || page >= totalPages} className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">下一页</button>
      </div>
    </nav>
  );
}

export function CursorPagination({
  page,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  disabled = false,
}: {
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  disabled?: boolean;
}) {
  if (!hasPrevious && !hasNext) return null;

  return (
    <nav className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5" aria-label="记录分页">
      <p className="text-xs text-slate-400">第 {page} 页</p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onPrevious} disabled={disabled || !hasPrevious} className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">上一页</button>
        <button type="button" onClick={onNext} disabled={disabled || !hasNext} className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">下一页</button>
      </div>
    </nav>
  );
}


"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type TooltipPosition = Readonly<{ left: number; top: number; maxHeight: number; above: boolean }>;

/** Short, on-demand field guidance that also works with keyboard and touch. */
export function HelpTooltip({ label, children }: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const open = position !== null;
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelHide() {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }

  function scheduleHide() {
    cancelHide();
    hideTimer.current = setTimeout(() => setPosition(null), 150);
  }

  function show() {
    cancelHide();
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds) return;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(288, viewportWidth - 32);
    const spaceAbove = bounds.top - 24;
    const spaceBelow = viewportHeight - bounds.bottom - 24;
    const above = spaceBelow < 220 && spaceAbove > spaceBelow;
    setPosition({
      left: Math.max(16 + width / 2, Math.min(viewportWidth - 16 - width / 2, bounds.left + bounds.width / 2)),
      top: above ? bounds.top - 8 : bounds.bottom + 8,
      maxHeight: Math.max(80, above ? spaceAbove : spaceBelow),
      above,
    });
  }

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setPosition(null);
    }
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !tooltip.current?.contains(event.target)) setPosition(null);
    }
    function closeOnScroll(event: Event) {
      if (event.target instanceof Node && !tooltip.current?.contains(event.target)) setPosition(null);
    }
    function closeOnResize() { setPosition(null); }
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [open]);

  useEffect(() => () => {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
  }, []);

  return (
    <span
      ref={root}
      className="relative inline-flex align-middle"
      onPointerEnter={show}
      onPointerLeave={(event) => { if (event.pointerType !== "touch") scheduleHide(); }}
      onFocus={show}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPosition(null); }}
    >
      <button
        type="button"
        aria-label={`${label}填写示例`}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={open ? id : undefined}
        onClick={show}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      ><span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-[10px] font-bold leading-none text-slate-600 hover:border-indigo-400 hover:text-indigo-700">?</span>
      </button>
      {position ? createPortal(<span ref={tooltip} id={id} role="tooltip" className="fixed z-[70] block w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-3 text-left text-xs font-normal leading-5 text-slate-700 shadow-xl" style={{ left: position.left, top: position.top, maxHeight: position.maxHeight, transform: `translate(-50%, ${position.above ? "-100%" : "0"})` }} onPointerEnter={cancelHide} onPointerLeave={scheduleHide}>{children}</span>, document.body) : null}
    </span>
  );
}

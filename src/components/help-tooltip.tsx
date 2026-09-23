"use client";

import { useEffect, useId, useRef, useState } from "react";

/** Short, on-demand field guidance that also works with keyboard and touch. */
export function HelpTooltip({ label, children }: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const wasOpenOnPointerDown = useRef(false);

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);

  return (
    <span
      ref={root}
      className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    >
      <button
        type="button"
        aria-label={`${label}填写示例`}
        aria-expanded={open}
        aria-controls={id}
        onPointerDown={() => { wasOpenOnPointerDown.current = open; }}
        onClick={(event) => setOpen(event.detail > 0 ? !wasOpenOnPointerDown.current : (current) => !current)}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-300 bg-white text-xs font-bold text-slate-600 outline-none hover:border-indigo-400 hover:text-indigo-700 focus-visible:ring-2 focus-visible:ring-indigo-400"
      >?
      </button>
      {open ? <span id={id} role="tooltip" className="fixed inset-x-4 bottom-4 z-50 block rounded-xl border border-slate-200 bg-slate-950 p-3 text-left text-xs font-normal leading-5 text-white shadow-xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2 sm:w-72">{children}</span> : null}
    </span>
  );
}

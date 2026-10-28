"use client";

import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const DialogFooterTargetContext = createContext<HTMLElement | null>(null);
const DialogFormContext = createContext<string | undefined>(undefined);

/** Keep terminal actions in the owning surface's footer, including nested editors. */
export function DialogActions({ children, className = "" }: { children: ReactNode; className?: string }) {
  const target = useContext(DialogFooterTargetContext);
  const actions = <div data-dialog-actions className={`flex min-w-0 flex-wrap items-center gap-3 ${target ? "justify-end" : "justify-start"} ${className}`}>{children}</div>;
  return target ? createPortal(actions, target) : actions;
}

/** A unique native form owner survives moving its submit controls to the footer. */
export function DialogForm({ children, id, ...props }: ComponentProps<"form">) {
  const generatedId = useId();
  const formId = id ?? generatedId;
  return <DialogFormContext.Provider value={formId}><form {...props} id={formId}>{children}</form></DialogFormContext.Provider>;
}

export function DialogSubmit({ form, ...props }: ComponentProps<"button">) {
  const owner = useContext(DialogFormContext);
  return <button {...props} type="submit" form={form ?? owner} />;
}

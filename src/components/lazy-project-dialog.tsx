"use client";

import { lazy, Suspense } from "react";
import type { ProjectDialogProps } from "./project-dialogs";

const Dialog = lazy(() => import("./project-dialogs"));

/** One import site prevents duplicate async copies across project entry points. */
export function ProjectDialog(props: ProjectDialogProps) {
  return <Suspense fallback={null}><Dialog {...props} /></Suspense>;
}

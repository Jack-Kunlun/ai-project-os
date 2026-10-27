"use client";

import type { ComponentProps } from "react";
import { ProjectLifecycleDialog } from "./project-lifecycle-dialog";
import { CreateProjectDialog } from "@/app/projects/create-project-dialog";

export type ProjectDialogProps =
  | ({ kind: "create" } & ComponentProps<typeof CreateProjectDialog>)
  | ({ kind: "lifecycle" } & ComponentProps<typeof ProjectLifecycleDialog>);

export default function ProjectDialog(props: ProjectDialogProps) {
  return props.kind === "create" ? <CreateProjectDialog {...props} /> : <ProjectLifecycleDialog {...props} />;
}

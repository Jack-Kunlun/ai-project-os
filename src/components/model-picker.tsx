import type { ReactNode } from "react";
import { ShellIcon } from "./shell-icon";
import styles from "./model-form-fields.module.css";

export function ModelPicker({ children }: { children: ReactNode }) {
  return (
    <span className={styles.picker}>
      {children}
      <ShellIcon name="down" className={styles.pickerIcon} />
    </span>
  );
}

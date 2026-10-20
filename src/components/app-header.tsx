"use client";
import { UserShell } from "./user-shell";

type PrimarySection = "dashboard" | "ask" | "projects" | "personalKnowledge" | "settings" | "connections" | "team" | "notifications" | "profile" | "guide" | "admin";
type ProjectSection = "overview" | "configuration" | "members" | "materials" | "assets" | "externalSources" | "repositories" | "world" | "plan" | "automations" | "tools" | "actions" | "control" | "memory" | "memoryQuality" | "intelligence" | "governance" | "guide";
/** Preserve callers while the persistent user shell owns the navigation. */
export function AppHeader({username,isSystemAdmin=false}: Readonly<{username:string;active:PrimarySection;projectId?:string;projectSection?:ProjectSection;isSystemAdmin?:boolean}>) {
  return <UserShell username={username} isSystemAdmin={isSystemAdmin}/>;
}

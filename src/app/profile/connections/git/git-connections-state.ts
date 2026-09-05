export type GitProviderKind = "github" | "gitee" | "gitlab" | "gitea" | "forgejo" | "generic";
export type GitTransport = "https" | "ssh";
export type GitAuthKind = "none" | "token" | "basic" | "sshKey";
export type GitConnectionStatus = "configured" | "verified" | "error" | "disabled";

export type GitCatalogEntry = Readonly<{
  kind: GitProviderKind;
  label: string;
  defaultHttpsUrl: string;
  defaultSshUrl: string;
}>;

export type GitConnection = Readonly<{
  id: string;
  name: string;
  providerKind: GitProviderKind;
  transport: GitTransport;
  baseUrl: string;
  authKind: GitAuthKind;
  username: string | null;
  allowPrivateNetwork: boolean;
  tlsCaCertificate: string | null;
  sshKnownHost: string | null;
  status: GitConnectionStatus;
  ownershipState: "legacyPending" | "confirmed" | "ambiguous";
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
  credential: { maskedSuffix: string; rotatedAt: string | null; updatedAt: string } | null;
  _count: { repositories: number };
}>;

export type GitConnectionDraft = Readonly<{
  name: string;
  providerKind: GitProviderKind;
  transport: GitTransport;
  baseUrl: string;
  authKind: GitAuthKind;
  username: string;
  secret: string;
  allowPrivateNetwork: boolean;
  tlsCaCertificate: string;
  sshKnownHost: string;
}>;

export type GitEditDraft = Readonly<{
  name: string;
  username: string;
  secret: string;
  allowPrivateNetwork: boolean;
  tlsCaCertificate: string;
  sshKnownHost: string;
}>;

export const gitProviderLabels: Record<GitProviderKind, string> = {
  github: "GitHub",
  gitee: "Gitee",
  gitlab: "GitLab / GitLab Self-Managed",
  gitea: "Gitea",
  forgejo: "Forgejo",
  generic: "通用 Git 服务",
};

export const gitStatusLabels: Record<GitConnectionStatus, string> = {
  configured: "待测试",
  verified: "已验证",
  error: "测试失败",
  disabled: "已停用",
};

export function createDefaultGitDraft(catalog: readonly GitCatalogEntry[] = []): GitConnectionDraft {
  const first = catalog[0];
  return {
    name: "",
    providerKind: first?.kind ?? "github",
    transport: "https",
    baseUrl: first?.defaultHttpsUrl ?? "https://github.com",
    authKind: "token",
    username: "",
    secret: "",
    allowPrivateNetwork: false,
    tlsCaCertificate: "",
    sshKnownHost: "",
  };
}

export function createGitEditDraft(connection: GitConnection): GitEditDraft {
  return {
    name: connection.name,
    username: connection.username ?? "",
    secret: "",
    allowPrivateNetwork: connection.allowPrivateNetwork,
    tlsCaCertificate: connection.tlsCaCertificate ?? "",
    sshKnownHost: connection.sshKnownHost ?? "",
  };
}

export function gitCredentialLabel(connection: Pick<GitConnection, "authKind" | "credential">): string {
  if (connection.authKind === "none") return "无凭据";
  return `····${connection.credential?.maskedSuffix ?? "未配置"}`;
}

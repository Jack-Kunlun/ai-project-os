export type ConnectionMessage = Readonly<{
  tone: "success" | "error" | "info";
  text: string;
}>;

export class ConnectionRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ConnectionRequestError";
  }
}

export async function readConnectionError(response: Response, fallback: string): Promise<ConnectionRequestError> {
  try {
    const payload = await response.json() as { error?: { code?: string; message?: string } };
    return new ConnectionRequestError(
      payload.error?.message ?? fallback,
      payload.error?.code ?? "CONNECTION_REQUEST_FAILED",
      response.status,
    );
  } catch {
    return new ConnectionRequestError(fallback, "CONNECTION_REQUEST_FAILED", response.status);
  }
}

export function isConnectionConflict(error: unknown): boolean {
  return error instanceof ConnectionRequestError && error.status === 409;
}

export function connectionErrorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function formatConnectionDate(value: string | null): string {
  if (!value) return "暂无记录";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export const connectionFieldClass = "mt-1.5 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-100 disabled:text-slate-500";

export const connectionButtonClass = "inline-flex min-h-10 items-center justify-center rounded-xl px-3 py-2 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50";

"use client";

export function csrfToken() {
  const entry = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("nursery_csrf="));
  return entry ? decodeURIComponent(entry.slice("nursery_csrf=".length)) : "";
}

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers({ accept: "application/json" });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET" && method !== "HEAD" && !path.includes("/login/")) headers.set("x-csrf-token", csrfToken());
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const result = await response.json() as T & { code?: string; message?: string };
  if (!response.ok) throw new ApiError(result.code ?? "REQUEST_FAILED", result.message ?? "処理を完了できませんでした。", response.status);
  return result;
}

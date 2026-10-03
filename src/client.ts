// The HTTP layer every tool shares: the key and address a call goes to, the
// request itself, and turning a failed answer into one DocCheapError that names
// what went wrong in words the model can act on.
import { DocCheapError } from "./errors.ts";
import { USER_AGENT } from "./version.ts";

export const DEFAULT_BASE_URL = "https://api.doc.cheap";

/**
 * The public sandbox key: anyone may use it, so the tools work before an
 * account exists. The API answers it with the sandbox allowance rather than a
 * balance.
 */
export const PUBLIC_SANDBOX_KEY = "sk_sandbox_public";

/** How every tool reaches doc.cheap. Each field falls back to the environment, then a default. */
export interface DocCheapOptions {
  /** The API key. Default: `DOC_CHEAP_API_KEY`, then the public sandbox key. */
  readonly apiKey?: string | undefined;
  /** The API's address. Default: `DOC_CHEAP_API_BASE`, then `https://api.doc.cheap`. */
  readonly baseUrl?: string | undefined;
  /** The fetch the API calls go through. Default: the runtime's own. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
}

// Both are read when a call is made rather than when the tools are built, so an
// environment loaded after the import (a `.env` file read at start-up) still
// applies.
export function resolveApiKey(option?: string): string {
  return nonEmpty(option) ?? nonEmpty(process.env.DOC_CHEAP_API_KEY) ?? PUBLIC_SANDBOX_KEY;
}

export function resolveBaseUrl(option?: string): string {
  const base = nonEmpty(option) ?? nonEmpty(process.env.DOC_CHEAP_API_BASE) ?? DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "");
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
}

function apiErrorOf(data: unknown): ApiErrorBody | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const inner = (data as { error?: unknown }).error;
  if (inner === null || typeof inner !== "object") return undefined;
  const { code, message } = inner as { code?: unknown; message?: unknown };
  return typeof code === "string" && typeof message === "string" ? { code, message } : undefined;
}

/**
 * Maps a non-2xx answer to the error a tool throws. Only 401 and 403 mean the
 * key is wrong; a 429 is the rate limit or the sandbox allowance, and calling
 * it an invalid key would send the user to replace a key that works.
 */
export function errorFromResponse(response: Response, data: unknown): DocCheapError {
  const status = response.status;
  const body = apiErrorOf(data);
  const code = body ? body.code : `http_${status}`;
  const detail = body ? body.message : `doc.cheap answered HTTP ${status}.`;
  if (status === 401 || status === 403) {
    return new DocCheapError(`The API key was refused (HTTP ${status}): ${detail}`, {
      status,
      code,
    });
  }
  if (status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : "";
    return new DocCheapError(`Rate limited by doc.cheap (HTTP 429): ${detail}${wait}`, {
      status,
      code,
    });
  }
  if (status === 404) {
    return new DocCheapError(`Not found (HTTP 404): ${detail}`, { status, code });
  }
  return new DocCheapError(`doc.cheap request failed (HTTP ${status}): ${detail}`, {
    status,
    code,
  });
}

export interface ApiRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Calls the API and returns the parsed JSON answer. The key goes as a Bearer
 * token, and a JSON body and its content type only when there is a body, so a
 * GET or DELETE carries neither.
 */
export async function callApi(options: DocCheapOptions, request: ApiRequest): Promise<unknown> {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${resolveApiKey(options.apiKey)}`,
    "User-Agent": USER_AGENT,
    ...request.headers,
  };
  const init: RequestInit = { method: request.method, headers };
  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(request.body);
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${request.path}`, init);
  } catch (error) {
    throw new DocCheapError(`Could not reach doc.cheap at ${baseUrl}: ${reasonOf(error)}`, {
      code: "network_error",
    });
  }
  const data = readJson(await response.text());
  if (!response.ok) throw errorFromResponse(response, data);
  if (data === undefined) {
    throw new DocCheapError(`doc.cheap answered HTTP ${response.status} without a JSON body.`, {
      status: response.status,
      code: "invalid_response",
    });
  }
  return data;
}

export function scanPath(id: string): string {
  return `/v1/scans/${encodeURIComponent(id)}`;
}

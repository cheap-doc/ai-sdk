// The HTTP layer every tool shares, driven through an injected fetch.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callApi,
  DEFAULT_BASE_URL,
  errorFromResponse,
  PUBLIC_SANDBOX_KEY,
  resolveApiKey,
  resolveBaseUrl,
  scanPath,
} from "./client.ts";
import { DocCheapError } from "./errors.ts";
import { USER_AGENT } from "./version.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Seen {
  url: string;
  init: RequestInit;
}

function fakeFetch(response: () => Response, seen: Seen[] = []): typeof globalThis.fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof globalThis.fetch;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

async function failureOf(promise: Promise<unknown>): Promise<DocCheapError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DocCheapError);
  return error as DocCheapError;
}

describe("resolveApiKey", () => {
  it("prefers the option, then DOC_CHEAP_API_KEY, then the public sandbox key", () => {
    vi.stubEnv("DOC_CHEAP_API_KEY", "");
    expect(resolveApiKey()).toBe(PUBLIC_SANDBOX_KEY);
    vi.stubEnv("DOC_CHEAP_API_KEY", " sk_from_env ");
    expect(resolveApiKey()).toBe("sk_from_env");
    expect(resolveApiKey("  ")).toBe("sk_from_env");
    expect(resolveApiKey("sk_from_option")).toBe("sk_from_option");
  });
});

describe("resolveBaseUrl", () => {
  it("prefers the option, then DOC_CHEAP_API_BASE, then the default, without trailing slashes", () => {
    vi.stubEnv("DOC_CHEAP_API_BASE", "");
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);
    vi.stubEnv("DOC_CHEAP_API_BASE", "https://env.example.test//");
    expect(resolveBaseUrl()).toBe("https://env.example.test");
    expect(resolveBaseUrl("https://option.example.test/")).toBe("https://option.example.test");
  });
});

describe("errorFromResponse", () => {
  const apiError = { error: { code: "some_code", message: "What went wrong." } };

  it("calls only 401 and 403 a refused key", () => {
    for (const status of [401, 403]) {
      const error = errorFromResponse(new Response(null, { status }), apiError);
      expect(error.message).toBe(`The API key was refused (HTTP ${status}): What went wrong.`);
      expect(error.status).toBe(status);
      expect(error.code).toBe("some_code");
    }
  });

  it("names a rate limit, with the wait when the API gave one", () => {
    const withWait = errorFromResponse(
      new Response(null, { status: 429, headers: { "retry-after": "60" } }),
      apiError,
    );
    expect(withWait.message).toBe(
      "Rate limited by doc.cheap (HTTP 429): What went wrong. Retry after 60 seconds.",
    );
    const without = errorFromResponse(new Response(null, { status: 429 }), apiError);
    expect(without.message).toBe("Rate limited by doc.cheap (HTTP 429): What went wrong.");
  });

  it("names a missing scan", () => {
    expect(errorFromResponse(new Response(null, { status: 404 }), apiError).message).toBe(
      "Not found (HTTP 404): What went wrong.",
    );
  });

  it("falls back to the status when the body is not the API's error shape", () => {
    for (const data of [undefined, null, "text", { error: null }, { error: { code: 1 } }]) {
      const error = errorFromResponse(new Response(null, { status: 500 }), data);
      expect(error.code).toBe("http_500");
      expect(error.message).toBe(
        "doc.cheap request failed (HTTP 500): doc.cheap answered HTTP 500.",
      );
    }
  });
});

describe("callApi", () => {
  it("sends a GET with the key, the user agent and no body", async () => {
    const seen: Seen[] = [];
    const data = await callApi(
      {
        apiKey: "sk_test_key",
        baseUrl: "https://api.example.test/",
        fetch: fakeFetch(() => json({ ok: true }), seen),
      },
      { method: "GET", path: "/v1/usage" },
    );
    expect(data).toEqual({ ok: true });
    expect(seen[0]?.url).toBe("https://api.example.test/v1/usage");
    expect(seen[0]?.init.method).toBe("GET");
    expect(seen[0]?.init.body).toBeUndefined();
    expect(seen[0]?.init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer sk_test_key",
      "User-Agent": USER_AGENT,
    });
  });

  it("sends a JSON body with its content type and the extra headers", async () => {
    const seen: Seen[] = [];
    await callApi(
      { fetch: fakeFetch(() => json({}), seen) },
      {
        method: "POST",
        path: "/v1/scans",
        body: { image: "abc" },
        headers: { "Idempotency-Key": "k1" },
      },
    );
    expect(seen[0]?.init.body).toBe('{"image":"abc"}');
    expect(seen[0]?.init.headers).toMatchObject({
      "Content-Type": "application/json",
      "Idempotency-Key": "k1",
    });
  });

  it("throws the API's error for a failed answer", async () => {
    const fetch = fakeFetch(() =>
      json({ error: { code: "not_found", message: "No such scan." } }, 404),
    );
    const error = await failureOf(callApi({ fetch }, { method: "GET", path: "/v1/scans/x" }));
    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);
  });

  it("refuses a successful answer that is not JSON", async () => {
    const fetch = fakeFetch(() => new Response("<html>", { status: 200 }));
    const error = await failureOf(callApi({ fetch }, { method: "GET", path: "/v1/usage" }));
    expect(error.code).toBe("invalid_response");
    expect(error.message).toBe("doc.cheap answered HTTP 200 without a JSON body.");
  });

  it("names the reason the API could not be reached, its cause included", async () => {
    const withCause = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
    }) as typeof globalThis.fetch;
    const error = await failureOf(
      callApi(
        { baseUrl: "https://api.example.test", fetch: withCause },
        { method: "GET", path: "/" },
      ),
    );
    expect(error.code).toBe("network_error");
    expect(error.status).toBeNull();
    expect(error.message).toBe(
      "Could not reach doc.cheap at https://api.example.test: fetch failed: getaddrinfo ENOTFOUND",
    );
    const bare = (async () => {
      throw new Error("aborted");
    }) as typeof globalThis.fetch;
    expect(
      (await failureOf(callApi({ fetch: bare }, { method: "GET", path: "/" }))).message,
    ).toMatch(/: aborted$/);
    const odd = (async () => {
      throw "offline";
    }) as typeof globalThis.fetch;
    expect(
      (await failureOf(callApi({ fetch: odd }, { method: "GET", path: "/" }))).message,
    ).toMatch(/: offline$/);
  });

  it("uses the runtime's fetch when none is given", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ balance: null }));
    try {
      expect(await callApi({}, { method: "GET", path: "/v1/usage" })).toEqual({ balance: null });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("scanPath", () => {
  it("escapes the id into the path", () => {
    expect(scanPath("a/b")).toBe("/v1/scans/a%2Fb");
  });
});

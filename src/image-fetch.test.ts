// The connection-time address check behind imageUrl, and the fetch-shaped
// client built on it. The resolver and the request opener are injected, so a
// name that answers differently each time – the rebinding case – and the
// answer a server gives are both something a test can make happen on demand.
import type { LookupAddress } from "node:dns";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DocCheapError } from "./errors.ts";
import { fetchImageBytes } from "./image.ts";
import {
  createGuardedLookup,
  createPinnedFetch,
  type RequestOpener,
  type ResolveAll,
} from "./image-fetch.ts";
import { USER_AGENT } from "./version.ts";

function resolver(answers: LookupAddress[] | Error): ResolveAll {
  return (_hostname, callback) => {
    if (answers instanceof Error) callback(answers as NodeJS.ErrnoException, []);
    else callback(null, answers);
  };
}

function lookupOnce(
  lookup: ReturnType<typeof createGuardedLookup>,
  options: { all?: boolean },
  hostname = "images.example.test",
): Promise<unknown[]> {
  return new Promise((resolve) => {
    (lookup as unknown as (h: string, o: object, cb: (...args: unknown[]) => void) => void)(
      hostname,
      options,
      (...args: unknown[]) => resolve(args),
    );
  });
}

interface FakeAnswer {
  readonly statusCode?: number;
  readonly statusMessage?: string;
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly body?: Buffer;
}

// A request opener that answers from memory, recording what it was asked.
function answering(answer: FakeAnswer | Error, seen: RequestOptions[] = []): RequestOpener {
  return (_url, options, callback) => {
    seen.push(options);
    const request = new EventEmitter() as ClientRequest;
    request.end = (() => {
      setImmediate(() => {
        if (answer instanceof Error) {
          request.emit("error", answer);
          return;
        }
        const incoming = new PassThrough() as unknown as IncomingMessage & PassThrough;
        Object.assign(incoming, {
          statusCode: answer.statusCode,
          statusMessage: answer.statusMessage,
          headers: answer.headers ?? {},
        });
        callback(incoming);
        incoming.end(answer.body ?? Buffer.alloc(0));
      });
      return request;
    }) as ClientRequest["end"];
    return request;
  };
}

describe("the lookup a connection is made through", () => {
  it("connects to a public address it has just checked", async () => {
    const lookup = createGuardedLookup(resolver([{ address: "93.184.216.34", family: 4 }]));
    expect(await lookupOnce(lookup, {})).toEqual([null, "93.184.216.34", 4]);
    expect(await lookupOnce(lookup, { all: true })).toEqual([
      null,
      [{ address: "93.184.216.34", family: 4 }],
    ]);
  });

  it("refuses the connection when any answer is private", async () => {
    const lookup = createGuardedLookup(
      resolver([
        { address: "93.184.216.34", family: 4 },
        { address: "172.28.0.5", family: 4 },
      ]),
    );
    const [error] = await lookupOnce(lookup, { all: true });
    expect(error).toBeInstanceOf(DocCheapError);
    expect(String((error as Error).message)).toContain("172.28.0.5");
  });

  it("refuses a name that resolves to nothing, and passes a resolver failure through", async () => {
    const [empty] = await lookupOnce(createGuardedLookup(resolver([])), {});
    expect(empty).toBeInstanceOf(DocCheapError);
    const failure = new Error("ENOTFOUND");
    const [passed] = await lookupOnce(createGuardedLookup(resolver(failure)), {});
    expect(passed).toBe(failure);
  });

  it("uses the system resolver when none is given, and refuses what it answers for localhost", async () => {
    const [error] = await lookupOnce(createGuardedLookup(), {}, "localhost");
    expect(error).toBeInstanceOf(DocCheapError);
    expect((error as DocCheapError).message).toMatch(/loopback/);
  });

  it("holds when the name changes its answer between the check and the connection", async () => {
    // The URL check sees a public answer; by the time the socket resolves the
    // name it answers with the metadata address, and that answer is refused.
    const rebinding: ResolveAll = (_hostname, callback) => {
      callback(null, [{ address: "169.254.169.254", family: 4 }]);
    };
    const pinned = createPinnedFetch({ lookup: createGuardedLookup(rebinding), timeoutMs: 5_000 });
    const failure = await fetchImageBytes("https://rebinding.example.test/image.jpg", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: pinned,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DocCheapError);
    expect(String((failure as Error).message)).toContain("169.254.169.254");
  });
});

describe("the client imageUrl is fetched with", () => {
  it("speaks https only", async () => {
    await expect(createPinnedFetch()("http://images.example.test/a.jpg")).rejects.toThrow(
      /must be an https: URL/,
    );
  });

  it("sends a GET through the guarded lookup with its own user agent", async () => {
    const seen: RequestOptions[] = [];
    const pinned = createPinnedFetch({
      request: answering({ statusCode: 200, body: Buffer.from("abc") }, seen),
    });
    const response = await pinned("https://images.example.test/a.jpg");
    expect(await response.text()).toBe("abc");
    expect(seen[0]?.method).toBe("GET");
    expect(typeof seen[0]?.lookup).toBe("function");
    expect(seen[0]?.headers).toMatchObject({ "user-agent": USER_AGENT });
  });

  it("carries the status, message and every header value across", async () => {
    const pinned = createPinnedFetch({
      request: answering({
        statusCode: 302,
        statusMessage: "Found",
        headers: { location: "/b.jpg", "set-cookie": ["a=1", "b=2"], "x-gone": undefined },
      }),
    });
    const response = await pinned(new URL("https://images.example.test/a.jpg"));
    expect(response.status).toBe(302);
    expect(response.statusText).toBe("Found");
    expect(response.headers.get("location")).toBe("/b.jpg");
    expect(response.headers.get("set-cookie")).toBe("a=1, b=2");
    expect(response.headers.has("x-gone")).toBe(false);
  });

  it("answers a status that may not carry a body with none", async () => {
    const pinned = createPinnedFetch({ request: answering({ statusCode: 204 }) });
    const response = await pinned("https://images.example.test/a.jpg");
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("reads an answer without a status as a bad gateway", async () => {
    const pinned = createPinnedFetch({ request: answering({}) });
    expect((await pinned("https://images.example.test/a.jpg")).status).toBe(502);
  });

  it("rejects when the request fails", async () => {
    const pinned = createPinnedFetch({ request: answering(new Error("ECONNRESET")) });
    await expect(pinned("https://images.example.test/a.jpg")).rejects.toThrow("ECONNRESET");
  });

  it("never reaches loopback, even through a name that resolves there", async () => {
    const pinned = createPinnedFetch({
      lookup: createGuardedLookup(resolver([{ address: "127.0.0.1", family: 4 }])),
    });
    const failure = await pinned("https://localhost.example.test/a.jpg").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DocCheapError);
    expect(String((failure as Error).message)).toContain("loopback");
  });
});

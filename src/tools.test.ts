// The five tools as the AI SDK runs them: the arguments a model sends, what
// goes to the API, and what goes back to the model. The API is a fake fetch.
import { describe, expect, it } from "vitest";
import type { ImageFetchDeps } from "./image.ts";
import * as entry from "./index.ts";
import {
  deleteScan,
  docCheapTools,
  getScan,
  getUsage,
  listScans,
  omitImagesForModel,
  scanDocument,
} from "./tools.ts";

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1,
]);
const SCAN_ID = "0b6f3c2e-4d1a-4f7e-9a3b-2c1d0e9f8a7b";
const CALL = { toolCallId: "call-1", messages: [], context: {} };

interface Seen {
  url: string;
  init: RequestInit;
}

function api(answer: unknown, seen: Seen[]): typeof globalThis.fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof globalThis.fetch;
}

// Calls a tool the way the AI SDK does once the model's arguments have passed
// the schema; the loose types let a test hand it partial or extra arguments.
function run(t: { execute?: unknown }, input: unknown): Promise<unknown> {
  const execute = t.execute as ((input: unknown, options: unknown) => unknown) | undefined;
  if (execute === undefined) throw new Error("tool has no execute");
  return Promise.resolve(execute(input, CALL));
}

const base = { baseUrl: "https://api.example.test", apiKey: "sk_test_key" };

describe("scanDocument", () => {
  it("posts the image alone when no option is set", async () => {
    const seen: Seen[] = [];
    const scan = scanDocument({ ...base, fetch: api({ meta: { billed: false } }, seen) });
    const result = await run(scan, { imageBase64: JPEG.toString("base64") });
    expect(result).toEqual({ meta: { billed: false } });
    expect(seen[0]?.url).toBe("https://api.example.test/v1/scans");
    expect(seen[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ image: JPEG.toString("base64") });
    expect(seen[0]?.init.headers).not.toHaveProperty("Idempotency-Key");
  });

  it("maps every option, the reference and the idempotency key", async () => {
    const seen: Seen[] = [];
    const deps: ImageFetchDeps = {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: (async () => new Response(JPEG)) as typeof globalThis.fetch,
    };
    const scan = scanDocument({ ...base, fetch: api({}, seen) }, () => deps);
    await run(scan, {
      imageUrl: "https://images.example.test/a.jpg",
      expectCountry: "UTO",
      returnPortrait: false,
      retainHours: 0,
      reference: "order-1",
      idempotencyKey: "retry-1",
    });
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      image: JPEG.toString("base64"),
      options: { expect_country: "UTO", return_portrait: false, retain_hours: 0 },
      reference: "order-1",
    });
    expect(seen[0]?.init.headers).toMatchObject({ "Idempotency-Key": "retry-1" });
  });

  it("refuses a bad image before anything reaches the API", async () => {
    const seen: Seen[] = [];
    const scan = scanDocument({ ...base, fetch: api({}, seen) });
    await expect(run(scan, {})).rejects.toThrow(/exactly one of imageUrl or imageBase64/);
    expect(seen).toEqual([]);
  });

  it("downloads imageUrl through the guarded client by default", async () => {
    const scan = scanDocument({ ...base, fetch: api({}, []) });
    await expect(run(scan, { imageUrl: "http://images.example.test/a.jpg" })).rejects.toThrow(
      /must be an https: URL/,
    );
  });

  it("checks the model's arguments against its schema", async () => {
    const schema = scanDocument().inputSchema as unknown as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ imageBase64: "x", expectCountry: "UTO" }).success).toBe(true);
    expect(schema.safeParse({ expectCountry: "uto" }).success).toBe(false);
    expect(schema.safeParse({ retainHours: 8761 }).success).toBe(false);
    expect(schema.safeParse({ reference: "r".repeat(129) }).success).toBe(false);
  });

  it("hands the model a copy without the base64 crops", () => {
    const scan = scanDocument();
    const output = { meta: { id: SCAN_ID }, images: { document: "data:image/jpeg;base64,AAAA" } };
    expect(scan.toModelOutput?.({ toolCallId: "call-1", input: {}, output })).toEqual({
      type: "json",
      value: {
        meta: { id: SCAN_ID },
        images: { document: "[image omitted from the model's copy: 27 characters of base64]" },
      },
    });
  });
});

describe("omitImagesForModel", () => {
  it("leaves anything without an images object as it is", () => {
    for (const value of [null, "text", 3, [1, 2], {}, { images: null }, { images: [1] }]) {
      expect(omitImagesForModel(value)).toEqual(value);
    }
  });

  it("replaces only data URLs, keeping null slots and other values", () => {
    const output = {
      images: { document: "data:image/png;base64,QUJD", main_photo: null, note: "kept" },
    };
    expect(omitImagesForModel(output)).toEqual({
      images: {
        document: "[image omitted from the model's copy: 26 characters of base64]",
        main_photo: null,
        note: "kept",
      },
    });
  });
});

describe("getScan and deleteScan", () => {
  it("read and delete one scan by its id", async () => {
    const seen: Seen[] = [];
    const fetch = api({ id: SCAN_ID }, seen);
    await run(getScan({ ...base, fetch }), { scanId: SCAN_ID });
    await run(deleteScan({ ...base, fetch }), { scanId: SCAN_ID });
    expect(seen.map((call) => [call.init.method, call.url])).toEqual([
      ["GET", `https://api.example.test/v1/scans/${SCAN_ID}`],
      ["DELETE", `https://api.example.test/v1/scans/${SCAN_ID}`],
    ]);
  });

  it("accept only a lower-case UUID", () => {
    const schema = getScan().inputSchema as unknown as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ scanId: SCAN_ID }).success).toBe(true);
    expect(schema.safeParse({ scanId: SCAN_ID.toUpperCase() }).success).toBe(false);
    expect(schema.safeParse({ scanId: "../usage" }).success).toBe(false);
  });

  it("strip the crops from the model's copy of a read-back scan", () => {
    const output = { images: { document: null } };
    expect(
      getScan().toModelOutput?.({ toolCallId: "c", input: { scanId: SCAN_ID }, output }),
    ).toEqual({
      type: "json",
      value: output,
    });
  });
});

describe("listScans", () => {
  it("adds limit and cursor only when they are given", async () => {
    const seen: Seen[] = [];
    const tool = listScans({ ...base, fetch: api({ scans: [], next_cursor: null }, seen) });
    await run(tool, {});
    await run(tool, { limit: 5 });
    await run(tool, { limit: 100, cursor: "abc" });
    expect(seen.map((call) => call.url)).toEqual([
      "https://api.example.test/v1/scans",
      "https://api.example.test/v1/scans?limit=5",
      "https://api.example.test/v1/scans?limit=100&cursor=abc",
    ]);
  });
});

describe("getUsage", () => {
  it("reads the account's usage", async () => {
    const seen: Seen[] = [];
    const result = await run(getUsage({ ...base, fetch: api({ balance: null }, seen) }), {});
    expect(result).toEqual({ balance: null });
    expect(seen[0]?.url).toBe("https://api.example.test/v1/usage");
  });
});

describe("docCheapTools", () => {
  it("builds all five tools with one set of options", async () => {
    const seen: Seen[] = [];
    const tools = docCheapTools({ ...base, fetch: api({}, seen) });
    expect(Object.keys(tools)).toEqual([
      "scanDocument",
      "getScan",
      "deleteScan",
      "listScans",
      "getUsage",
    ]);
    await run(tools.getUsage, {});
    expect(seen[0]?.init.headers).toMatchObject({ Authorization: "Bearer sk_test_key" });
  });

  it("works with no options at all", () => {
    expect(Object.keys(docCheapTools())).toHaveLength(5);
  });
});

describe("the package entry", () => {
  it("exports the tools, the error and the constants", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "DEFAULT_BASE_URL",
      "DocCheapError",
      "PACKAGE_VERSION",
      "PUBLIC_SANDBOX_KEY",
      "deleteScan",
      "docCheapTools",
      "getScan",
      "getUsage",
      "listScans",
      "scanDocument",
    ]);
  });
});

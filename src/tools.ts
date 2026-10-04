// The five doc.cheap tools, each built with the AI SDK's `tool()` helper so it
// drops straight into `generateText({ tools })`. Every tool calls the API; the
// zod schemas below are what the model sees and what its arguments are checked
// against before `execute` runs.
import { type JSONValue, type Tool, tool } from "ai";
import { z } from "zod";
import { callApi, type DocCheapOptions, scanPath } from "./client.ts";
import { defaultImageFetchDeps, type ImageFetchDeps, resolveImage } from "./image.ts";

const SANDBOX_ALLOWANCE =
  "Without an API key the public sandbox key is used. It gives 10 free recognised documents " +
  "per address in all, and at most 10 requests per address an hour, whatever their answer. " +
  "Registering gives 100 free documents every month.";

const STORED_SCANS_SCOPE =
  "Only scans made with a live key under a non-zero retention window are stored, and only " +
  "until that window ends (retainHours on the scan, or the account's history-retention " +
  "setting, one year by default); a scan made with retainHours 0 was never stored. " +
  "A key reaches its own account's scans and no other account's. Under a sandbox key – " +
  "the public one or an account's own sk_sandbox_ key – nothing is stored.";

const SCAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const scanIdInput = z
  .string()
  .regex(SCAN_ID)
  .describe(
    "The scan's id: meta.id of a scanDocument result, or id of a listScans row " +
      "(a lower-case UUID).",
  );

const scanDocumentInput = z.object({
  imageUrl: z
    .string()
    .optional()
    .describe(
      "https: URL of a JPEG or PNG image on a public internet address, fetched by this " +
        "package (25 MB maximum). Give this or imageBase64, not both.",
    ),
  imageBase64: z
    .string()
    .optional()
    .describe("The document image as base64, JPEG or PNG (a data: URL is also accepted)."),
  expectCountry: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .describe("ISO 3166-1 alpha-3 country you expect, or omit for any."),
  returnPortrait: z
    .boolean()
    .optional()
    .describe("Whether to include the holder photograph crop, images.main_photo (default true)."),
  retainHours: z
    .number()
    .int()
    .min(0)
    .max(8760)
    .optional()
    .describe(
      "Hours the result stays readable through getScan (0 = store nothing). " +
        "Omit it to use the account's own history-retention setting.",
    ),
  reference: z
    .string()
    .max(128)
    .optional()
    .describe("Your own correlation string, echoed back in the result."),
  idempotencyKey: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Makes a retried scan return the first result instead of charging again."),
});

const listScansInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Rows per page, 1 to 100 (default 20)."),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe("next_cursor from the previous page; omit it for the first page."),
});

export type ScanDocumentInput = z.infer<typeof scanDocumentInput>;
export type ScanIdInput = { scanId: string };
export type ListScansInput = z.infer<typeof listScansInput>;

/** The answer of the API, passed to the caller as it came. */
export type ApiAnswer = JSONValue;

const DATA_URL = /^data:[^,]*;base64,/i;

// A Scan carries its image crops as base64 data URLs, often hundreds of
// kilobytes each. The caller's code still gets them in the tool result; only
// the copy sent back to the model is replaced by a size note, because a model
// cannot look at base64 text and it would spend the context window for nothing.
export function omitImagesForModel(output: unknown): JSONValue {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return output as JSONValue;
  }
  const images = (output as { images?: unknown }).images;
  if (images === null || typeof images !== "object" || Array.isArray(images)) {
    return output as JSONValue;
  }
  const slots: Record<string, JSONValue> = {};
  for (const [name, value] of Object.entries(images)) {
    slots[name] =
      typeof value === "string" && DATA_URL.test(value)
        ? `[image omitted from the model's copy: ${value.length} characters of base64]`
        : (value as JSONValue);
  }
  return { ...(output as Record<string, JSONValue>), images: slots };
}

function toModelJson({ output }: { output: unknown }): { type: "json"; value: JSONValue } {
  return { type: "json", value: omitImagesForModel(output) };
}

/**
 * Recognise a passport, ID card or driving licence. The second argument is
 * where `imageUrl` downloads go through; it exists for tests and is left out
 * everywhere else.
 */
export function scanDocument(
  options: DocCheapOptions = {},
  imageDeps: () => ImageFetchDeps = defaultImageFetchDeps,
): Tool<ScanDocumentInput, ApiAnswer> {
  return tool({
    description:
      "Recognise a passport, national ID card or driver's licence from a photo or scan and " +
      "return what is printed on it as structured JSON. Give the image as imageUrl or " +
      "imageBase64 (JPEG or PNG). " +
      "Output: a Scan object – meta (id, status, billed, confidence, timing), document " +
      "(kind, issuing country, number, dates of issue and expiry), holder (given names, " +
      "surname, date of birth, sex, nationality), fields (every field read off the page, " +
      "each with its own confidence), mrz (whether the machine-readable zone checks out, " +
      "and its lines as read), images, quality and authenticity. " +
      "Cost: it bills one credit ($0.01) only when a document is recognised; an unreadable " +
      "image, an empty frame or an unsupported type costs nothing, and meta.billed says " +
      "which happened. " +
      SANDBOX_ALLOWANCE,
    inputSchema: scanDocumentInput,
    execute: async (input) => {
      const image = await resolveImage(input, imageDeps);
      const scanOptions: Record<string, JSONValue> = {};
      if (input.expectCountry !== undefined) scanOptions.expect_country = input.expectCountry;
      if (input.returnPortrait !== undefined) scanOptions.return_portrait = input.returnPortrait;
      if (input.retainHours !== undefined) scanOptions.retain_hours = input.retainHours;
      const body: Record<string, JSONValue> = { image };
      if (Object.keys(scanOptions).length > 0) body.options = scanOptions;
      if (input.reference !== undefined) body.reference = input.reference;
      const headers: Record<string, string> = {};
      if (input.idempotencyKey !== undefined) headers["Idempotency-Key"] = input.idempotencyKey;
      return (await callApi(options, {
        method: "POST",
        path: "/v1/scans",
        body,
        headers,
      })) as ApiAnswer;
    },
    toModelOutput: toModelJson,
  });
}

/** Read back one stored scan by its id. */
export function getScan(options: DocCheapOptions = {}): Tool<ScanIdInput, ApiAnswer> {
  return tool({
    description:
      "Fetch the full result of one stored scan by its id, as it was returned when the " +
      "document was recognised. Output: the same Scan object scanDocument returns, with " +
      "two differences: the image crops are never stored, so every images slot is null, " +
      "and quality reads not_checked. It never re-runs recognition and never charges a " +
      "credit. " +
      STORED_SCANS_SCOPE +
      " An id that is unknown, belongs to another account, was made with retainHours 0 or " +
      "has passed its window is refused as not_found.",
    inputSchema: z.object({ scanId: scanIdInput }),
    execute: async ({ scanId }) =>
      (await callApi(options, { method: "GET", path: scanPath(scanId) })) as ApiAnswer,
    toModelOutput: toModelJson,
  });
}

/** Permanently delete one stored scan. */
export function deleteScan(options: DocCheapOptions = {}): Tool<ScanIdInput, ApiAnswer> {
  return tool({
    description:
      "Permanently delete one stored scan now, before its retention window would end. " +
      "This cannot be undone: the stored result and its history row are removed. The " +
      "credit it drew is not refunded. Output: { id, deleted: true }. " +
      STORED_SCANS_SCOPE +
      " An id that is unknown, belongs to another account or was already deleted is " +
      "refused as not_found, and nothing is deleted. Confirm the id with listScans or " +
      "getScan first, because the deletion is final.",
    inputSchema: z.object({ scanId: scanIdInput }),
    execute: async ({ scanId }) =>
      (await callApi(options, { method: "DELETE", path: scanPath(scanId) })) as ApiAnswer,
  });
}

/** List the account's stored scans, newest first, one page at a time. */
export function listScans(options: DocCheapOptions = {}): Tool<ListScansInput, ApiAnswer> {
  return tool({
    description:
      "List the account's stored scans, most recent first, one page at a time. " +
      "Output: scans – one row per scan with id, status (recognized, unreadable, " +
      "no_document_found, unsupported_document or rejected), billed, duration_ms, reference " +
      "and created_at – and next_cursor, which is null on the last page. A row holds no " +
      "extracted data; call getScan with its id for the full result. It never charges a " +
      "credit. " +
      STORED_SCANS_SCOPE,
    inputSchema: listScansInput,
    execute: async ({ limit, cursor }) => {
      const query = new URLSearchParams();
      if (limit !== undefined) query.set("limit", String(limit));
      if (cursor !== undefined) query.set("cursor", cursor);
      const search = query.size > 0 ? `?${query.toString()}` : "";
      return (await callApi(options, { method: "GET", path: `/v1/scans${search}` })) as ApiAnswer;
    },
  });
}

/** The account's balance and this period's usage. */
export function getUsage(options: DocCheapOptions = {}): Tool<Record<string, never>, ApiAnswer> {
  return tool({
    description:
      "Return how many credits are left on the account and what the current period has " +
      "used: the balance, split into this month's free credits (100 every month, drawn " +
      "first) and the paid credits, the credits spent, and the scan counters by status. " +
      "One recognised document draws one credit, at $0.01; scans that recognised nothing " +
      "are counted and never charged. Under the public sandbox key there is no account " +
      "behind the call, so the balance is null. Use it before working through a batch of " +
      "documents, or when a scan is refused for lack of credit.",
    inputSchema: z.object({}),
    execute: async () =>
      (await callApi(options, { method: "GET", path: "/v1/usage" })) as ApiAnswer,
  });
}

// A type alias rather than an interface on purpose: the AI SDK's `ToolSet` is
// a record with a string index signature, and TypeScript lets an object type
// alias satisfy one but never an interface. As an interface, passing
// `docCheapTools()` straight as `tools` fails under `strict`; tool-set.test.ts
// holds that call so the declaration cannot drift back.
export type DocCheapTools = {
  readonly scanDocument: Tool<ScanDocumentInput, ApiAnswer>;
  readonly getScan: Tool<ScanIdInput, ApiAnswer>;
  readonly deleteScan: Tool<ScanIdInput, ApiAnswer>;
  readonly listScans: Tool<ListScansInput, ApiAnswer>;
  readonly getUsage: Tool<Record<string, never>, ApiAnswer>;
};

/** All five tools sharing one set of options, ready to pass as `tools` or spread into it. */
export function docCheapTools(options: DocCheapOptions = {}): DocCheapTools {
  return {
    scanDocument: scanDocument(options),
    getScan: getScan(options),
    deleteScan: deleteScan(options),
    listScans: listScans(options),
    getUsage: getUsage(options),
  };
}

// Turns the image a tool call names into the base64 the API expects.
import { lookup as dnsLookup } from "node:dns/promises";
import {
  type AddressLookup,
  assertAllowedImageUrl,
  MAX_IMAGE_BYTES,
  MAX_REDIRECTS,
} from "./address.ts";
import { DocCheapError, imageRefused, invalidInput } from "./errors.ts";
import { createPinnedFetch } from "./image-fetch.ts";

export interface ImageInput {
  readonly imageBase64?: string | undefined;
  readonly imageUrl?: string | undefined;
}

/** The I/O an image URL is fetched with, injectable so the guards can be tested dry. */
export interface ImageFetchDeps {
  readonly lookup: AddressLookup;
  readonly fetchImpl: typeof globalThis.fetch;
}

// The name is checked once up front, which answers the caller with the precise
// reason, and again by the pinned client at the moment it connects, which is
// the check that cannot be raced (`./image-fetch.ts`).
export function defaultImageFetchDeps(): ImageFetchDeps {
  return {
    lookup: (hostname) => dnsLookup(hostname, { all: true }),
    fetchImpl: createPinnedFetch(),
  };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function tooLarge(what: string): DocCheapError {
  return invalidInput(`${what} is larger than 25 MiB, the most the API accepts.`);
}

// A request to the caller's own URL that never got an answer – refused, reset,
// timed out, a certificate that does not verify – is the URL's problem, so it
// goes back as a message naming the reason.
async function fetchOnce(deps: ImageFetchDeps, target: URL): Promise<Response> {
  try {
    return await deps.fetchImpl(target, { redirect: "manual" });
  } catch (error) {
    if (error instanceof DocCheapError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw imageRefused(`Could not fetch imageUrl (${reason}).`);
  }
}

// Reads the body while counting bytes. `content-length` is a claim by the
// remote server, so it is checked when present but never trusted: the stream is
// cut off at the same ceiling whether the header was absent, wrong or lying.
async function readCappedBody(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw tooLarge("The imageUrl body");

  const body = response.body;
  if (body === null) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw tooLarge("The imageUrl body");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetches an image over https from a public address.
 *
 * Redirects are followed by hand rather than by `fetch`, because an automatic
 * follow would let a URL that passes the check hand off to one that never
 * could – a public host answering `302 Location: http://169.254.169.254/` is
 * the whole attack. Every hop goes through the same scheme and address check.
 */
export async function fetchImageBytes(rawUrl: string, deps: ImageFetchDeps): Promise<Buffer> {
  let target = await assertAllowedImageUrl(rawUrl, deps.lookup);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchOnce(deps, target);
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (location === null) {
        throw imageRefused(
          `imageUrl answered HTTP ${response.status} with no Location header to follow.`,
        );
      }
      target = await assertAllowedImageUrl(new URL(location, target).href, deps.lookup);
      continue;
    }
    if (!response.ok) {
      throw imageRefused(`Could not fetch imageUrl (HTTP ${response.status}).`);
    }
    return readCappedBody(response);
  }
  throw imageRefused(`imageUrl redirected more than ${MAX_REDIRECTS} times; giving up.`);
}

// JPEG: the start-of-image marker FF D8, then the FF that opens the next marker.
// PNG: the eight-byte signature, then the IHDR chunk type at offset 12, which
// the format requires as the first chunk.
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_IHDR = [0x49, 0x48, 0x44, 0x52];
const PNG_IHDR_OFFSET = 12;
const SIGNATURE_BYTES = PNG_IHDR_OFFSET + PNG_IHDR.length;
const SIGNATURE_BASE64_CHARS = Math.ceil(SIGNATURE_BYTES / 3) * 4;

function startsWith(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

/** True when the leading bytes are those of a JPEG or a PNG, the formats the API reads. */
export function isSupportedImage(bytes: Uint8Array): boolean {
  if (startsWith(bytes, JPEG_SIGNATURE)) return true;
  return startsWith(bytes, PNG_SIGNATURE) && startsWith(bytes, PNG_IHDR, PNG_IHDR_OFFSET);
}

// The API refuses anything but JPEG and PNG; checking here answers before an
// upload of bytes that could only be refused, in words that name the input.
function assertSupportedImage(base64: string, source: string): string {
  const head = Buffer.from(base64.slice(0, SIGNATURE_BASE64_CHARS), "base64");
  if (!isSupportedImage(head)) {
    throw invalidInput(
      `${source} is not a JPEG or PNG image. Send a photo or scan of the document as JPEG or PNG.`,
    );
  }
  return base64;
}

// The decoded size of a base64 string, without decoding it.
function decodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

// Accepts plain base64 or a `data:` URL carrying it, with or without line breaks.
function readBase64(value: string): string {
  const match = /^data:[^,]*;base64,(.*)$/is.exec(value.trim());
  const compact = (match?.[1] ?? value).replace(/\s+/g, "");
  if (compact === "" || !BASE64.test(compact)) {
    throw invalidInput("imageBase64 is not valid base64 or a base64 data URL.");
  }
  if (decodedLength(compact) > MAX_IMAGE_BYTES) throw tooLarge("imageBase64");
  return compact;
}

/**
 * The base64 image of a tool call. Exactly one of `imageBase64` and `imageUrl`
 * must be given; both or neither is a clear tool error rather than a guess.
 */
export async function resolveImage(input: ImageInput, deps: () => ImageFetchDeps): Promise<string> {
  const hasBase64 = typeof input.imageBase64 === "string" && input.imageBase64.trim() !== "";
  const hasUrl = typeof input.imageUrl === "string" && input.imageUrl.trim() !== "";
  if (hasBase64 === hasUrl) {
    throw invalidInput("Provide the image as exactly one of imageUrl or imageBase64.");
  }
  if (hasBase64) {
    return assertSupportedImage(readBase64(input.imageBase64 as string), "imageBase64");
  }
  const bytes = await fetchImageBytes((input.imageUrl as string).trim(), deps());
  if (bytes.length === 0) {
    throw imageRefused("The image downloaded from imageUrl is empty.");
  }
  return assertSupportedImage(bytes.toString("base64"), "imageUrl");
}

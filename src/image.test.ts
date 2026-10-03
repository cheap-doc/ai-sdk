// Turning a tool call's image into base64: the URL download with its redirect
// and size guards, and the base64 input with its format check. Every download
// is served by an injected fetch, so nothing here touches the network.
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES } from "./address.ts";
import { DocCheapError } from "./errors.ts";
import {
  defaultImageFetchDeps,
  fetchImageBytes,
  type ImageFetchDeps,
  isSupportedImage,
  resolveImage,
} from "./image.ts";

// Synthetic headers only: the bytes a JPEG and a PNG start with, and nothing else.
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1,
]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0,
]);
const GIF = Buffer.from("GIF89a-not-a-document-image");

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function serving(...responses: Response[]): ImageFetchDeps & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    lookup: publicLookup,
    fetchImpl: (async (input: string | URL) => {
      urls.push(String(input));
      const next = responses.shift();
      if (next === undefined) throw new Error("no more answers");
      return next;
    }) as typeof globalThis.fetch,
  };
}

function redirect(location: string | null, status = 302): Response {
  const headers = new Headers();
  if (location !== null) headers.set("location", location);
  return new Response(null, { status, headers });
}

async function failureOf(promise: Promise<unknown>): Promise<DocCheapError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DocCheapError);
  return error as DocCheapError;
}

describe("isSupportedImage", () => {
  it("knows a JPEG and a PNG by their leading bytes", () => {
    expect(isSupportedImage(JPEG)).toBe(true);
    expect(isSupportedImage(PNG)).toBe(true);
  });

  it("refuses anything else, a PNG without its header chunk and a short buffer included", () => {
    expect(isSupportedImage(GIF)).toBe(false);
    expect(isSupportedImage(PNG.subarray(0, 10))).toBe(false);
    const noHeader = Buffer.from(PNG);
    noHeader[12] = 0x58;
    expect(isSupportedImage(noHeader)).toBe(false);
    expect(isSupportedImage(new Uint8Array())).toBe(false);
  });
});

describe("fetchImageBytes", () => {
  it("returns the body of a plain answer", async () => {
    const deps = serving(new Response(JPEG));
    expect(await fetchImageBytes("https://images.example.test/a.jpg", deps)).toEqual(JPEG);
  });

  it("follows a redirect by hand, re-checking the next hop", async () => {
    const deps = serving(
      redirect("/b.jpg", 301),
      redirect("https://cdn.example.test/c.jpg"),
      new Response(PNG),
    );
    expect(await fetchImageBytes("https://images.example.test/a.jpg", deps)).toEqual(PNG);
    expect(deps.urls).toEqual([
      "https://images.example.test/a.jpg",
      "https://images.example.test/b.jpg",
      "https://cdn.example.test/c.jpg",
    ]);
  });

  it("refuses a redirect to a private address", async () => {
    const deps = serving(redirect("https://169.254.169.254/latest/meta-data/"));
    const error = await failureOf(fetchImageBytes("https://images.example.test/a.jpg", deps));
    expect(error.message).toContain("link-local");
  });

  it("refuses a redirect without a Location header", async () => {
    const deps = serving(redirect(null, 307));
    const error = await failureOf(fetchImageBytes("https://images.example.test/a.jpg", deps));
    expect(error.message).toBe("imageUrl answered HTTP 307 with no Location header to follow.");
  });

  it("gives up after three redirects", async () => {
    const deps = serving(redirect("/1"), redirect("/2"), redirect("/3"), redirect("/4"));
    const error = await failureOf(fetchImageBytes("https://images.example.test/a.jpg", deps));
    expect(error.message).toBe("imageUrl redirected more than 3 times; giving up.");
  });

  it("refuses an answer that is not OK", async () => {
    const deps = serving(new Response("gone", { status: 404 }));
    const error = await failureOf(fetchImageBytes("https://images.example.test/a.jpg", deps));
    expect(error.code).toBe("image_refused");
    expect(error.message).toBe("Could not fetch imageUrl (HTTP 404).");
  });

  it("names the reason a request never got an answer", async () => {
    const deps: ImageFetchDeps = {
      lookup: publicLookup,
      fetchImpl: async () => {
        throw new TypeError("connect ECONNREFUSED 93.184.216.34:443");
      },
    };
    const error = await failureOf(fetchImageBytes("https://images.example.test/a.jpg", deps));
    expect(error.message).toBe(
      "Could not fetch imageUrl (connect ECONNREFUSED 93.184.216.34:443).",
    );
    const odd: ImageFetchDeps = {
      lookup: publicLookup,
      fetchImpl: async () => {
        throw "socket hang up";
      },
    };
    expect(
      (await failureOf(fetchImageBytes("https://images.example.test/a.jpg", odd))).message,
    ).toBe("Could not fetch imageUrl (socket hang up).");
  });

  it("passes its own refusal through unchanged", async () => {
    const own = new DocCheapError("refused at connect", { code: "image_refused" });
    const deps: ImageFetchDeps = {
      lookup: publicLookup,
      fetchImpl: async () => {
        throw own;
      },
    };
    expect(await failureOf(fetchImageBytes("https://images.example.test/a.jpg", deps))).toBe(own);
  });

  it("refuses a body whose declared length is over 25 MiB without reading it", async () => {
    const headers = { "content-length": String(MAX_IMAGE_BYTES + 1) };
    const deps = serving(new Response(JPEG, { headers }));
    const error = await failureOf(fetchImageBytes("https://images.example.test/a.jpg", deps));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("larger than 25 MiB");
  });

  it("cuts a body off at 25 MiB when the length was not declared", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const deps = serving(new Response(stream));
    const error = await failureOf(fetchImageBytes("https://images.example.test/a.jpg", deps));
    expect(error.message).toContain("larger than 25 MiB");
    expect(sent).toBeLessThan(30);
  });

  it("reads an answer with no body as empty", async () => {
    const deps = serving(new Response(null, { status: 200 }));
    expect((await fetchImageBytes("https://images.example.test/a.jpg", deps)).length).toBe(0);
  });
});

describe("resolveImage", () => {
  const unused = () => {
    throw new Error("no download expected");
  };

  it("wants exactly one of imageUrl and imageBase64", async () => {
    const message = "Provide the image as exactly one of imageUrl or imageBase64.";
    expect((await failureOf(resolveImage({}, unused))).message).toBe(message);
    expect(
      (await failureOf(resolveImage({ imageBase64: " ", imageUrl: "" }, unused))).message,
    ).toBe(message);
    const both = { imageBase64: JPEG.toString("base64"), imageUrl: "https://a.example.test/" };
    expect((await failureOf(resolveImage(both, unused))).message).toBe(message);
  });

  it("accepts plain base64 and a data URL, line breaks included", async () => {
    const base64 = JPEG.toString("base64");
    expect(await resolveImage({ imageBase64: base64 }, unused)).toBe(base64);
    const wrapped = `data:image/png;base64,${PNG.toString("base64").replace(/(.{8})/g, "$1\n")}`;
    expect(await resolveImage({ imageBase64: wrapped }, unused)).toBe(PNG.toString("base64"));
  });

  it("refuses base64 that does not parse", async () => {
    for (const imageBase64 of ["not base64!", "data:image/png;base64,"]) {
      const error = await failureOf(resolveImage({ imageBase64 }, unused));
      expect(error.message).toBe("imageBase64 is not valid base64 or a base64 data URL.");
    }
  });

  it("refuses base64 over 25 MiB before decoding it", async () => {
    const huge = "A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8);
    const error = await failureOf(resolveImage({ imageBase64: huge }, unused));
    expect(error.message).toBe("imageBase64 is larger than 25 MiB, the most the API accepts.");
    const padded = await failureOf(resolveImage({ imageBase64: `${huge}=` }, unused));
    expect(padded.message).toContain("larger than 25 MiB");
    const doublePadded = await failureOf(resolveImage({ imageBase64: `${huge}==` }, unused));
    expect(doublePadded.message).toContain("larger than 25 MiB");
  });

  it("refuses an image that is neither JPEG nor PNG, naming the input", async () => {
    const fromBase64 = await failureOf(
      resolveImage({ imageBase64: GIF.toString("base64") }, unused),
    );
    expect(fromBase64.message).toMatch(/^imageBase64 is not a JPEG or PNG image\./);
    const fromUrl = await failureOf(
      resolveImage({ imageUrl: "https://images.example.test/a.gif" }, () =>
        serving(new Response(GIF)),
      ),
    );
    expect(fromUrl.message).toMatch(/^imageUrl is not a JPEG or PNG image\./);
  });

  it("downloads imageUrl and returns it as base64", async () => {
    const deps = serving(new Response(JPEG));
    const result = await resolveImage(
      { imageUrl: "  https://images.example.test/a.jpg " },
      () => deps,
    );
    expect(result).toBe(JPEG.toString("base64"));
    expect(deps.urls).toEqual(["https://images.example.test/a.jpg"]);
  });

  it("refuses an empty download", async () => {
    const error = await failureOf(
      resolveImage({ imageUrl: "https://images.example.test/a.jpg" }, () =>
        serving(new Response(new Uint8Array())),
      ),
    );
    expect(error.message).toBe("The image downloaded from imageUrl is empty.");
  });
});

describe("defaultImageFetchDeps", () => {
  it("builds the system resolver and the pinned client", async () => {
    const deps = defaultImageFetchDeps();
    expect(typeof deps.fetchImpl).toBe("function");
    const answers = await deps.lookup("localhost");
    expect(answers.length).toBeGreaterThan(0);
  });
});

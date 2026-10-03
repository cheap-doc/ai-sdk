# @doc-cheap/ai-sdk

[doc.cheap](https://doc.cheap) tools for the [AI SDK](https://ai-sdk.dev): a
model that has them can read a photo or scan of a passport, national ID card or
driving licence and get back the printed fields – name, date of birth, document
number, expiry, the machine-readable zone – as structured JSON.

One recognised document costs one credit, $0.01. Registering gives 100 free
documents every month. An unreadable image, an empty frame or an unsupported
document type costs nothing, and every answer says whether it was billed.

[Installation](#installation) ·
[Usage](#usage) ·
[API key](#api-key) ·
[Tools](#tools) ·
[Errors](#errors) ·
[Resources](#resources) ·
[Version history](#version-history)

## Installation

```sh
npm install @doc-cheap/ai-sdk ai zod
```

`ai` (version 6 or 7) and `zod` (3.25.76 or later, or 4) are peer
dependencies: the package uses the copies your project already has. It needs
Node.js 20 or later.

## Usage

```ts
import { generateText, isStepCount } from "ai";
import { docCheapTools } from "@doc-cheap/ai-sdk";

const { text } = await generateText({
  model: "openai/gpt-5-mini",
  tools: docCheapTools(),
  stopWhen: isStepCount(3),
  prompt:
    "Read the passport at https://example.com/passport.jpg and tell me " +
    "the holder's name and when the passport expires.",
});

console.log(text);
```

`docCheapTools()` returns all five tools. To give the model only some of them,
build each one on its own:

```ts
import { getUsage, scanDocument } from "@doc-cheap/ai-sdk";

const tools = { scanDocument: scanDocument(), getUsage: getUsage() };
```

Every builder takes the same options:

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `DOC_CHEAP_API_KEY`, then `sk_sandbox_public` | The key sent as a Bearer token. |
| `baseUrl` | `DOC_CHEAP_API_BASE`, then `https://api.doc.cheap` | The API's address. |
| `fetch` | the runtime's own | The fetch the API calls go through. |

The environment is read when a tool runs, not when it is built, so a `.env`
file loaded after the import still applies.

## API key

Set `DOC_CHEAP_API_KEY` to a live key (`sk_live_…`) from the
[doc.cheap cabinet](https://doc.cheap/docs/concepts/api-keys-and-sessions).

Without a key the tools use the public sandbox key `sk_sandbox_public`, so
they work before you have an account. The sandbox gives 10 free recognised
documents per address in all, and at most 10 requests per address an hour,
whatever their answer. Nothing made under a sandbox key is stored.

## Tools

| Tool | API call | What it does |
| --- | --- | --- |
| `scanDocument` | `POST /v1/scans` | Recognises a passport, ID card or driving licence. |
| `getScan` | `GET /v1/scans/{id}` | Reads back a stored result. Never charges. |
| `deleteScan` | `DELETE /v1/scans/{id}` | Deletes a stored result for good. |
| `listScans` | `GET /v1/scans` | Lists stored results, newest first, a page at a time. |
| `getUsage` | `GET /v1/usage` | This month's free credits, the paid credits and the scan counters. |

### scanDocument

| Input | Type | Meaning |
| --- | --- | --- |
| `imageUrl` | string | An `https:` URL of a JPEG or PNG on a public address. The package downloads it itself, 25 MiB at most. |
| `imageBase64` | string | The image as base64, or a `data:` URL. Give this or `imageUrl`, not both. |
| `expectCountry` | string | Optional. The country you expect, a three-letter code such as `GRC`. |
| `returnPortrait` | boolean | Optional. Whether to return the holder's photo crop (default true). |
| `retainHours` | number | Optional. How many hours the result can be read back, 0 to 8760. Empty uses the account's setting. |
| `reference` | string | Optional. Your own reference, up to 128 characters, echoed back. |
| `idempotencyKey` | string | Optional. Sending the same key again returns the first answer instead of charging a second scan. |

The result is the scan as the API returns it: `meta` (id, status, whether it
was billed, confidence), the document, the holder, every field read off the
page, the machine-readable zone and the image crops. Your code gets the whole
result. The copy the model sees has each image crop replaced by a short note
of its size, because a model cannot look at base64 text and it would fill the
context window.

**Image URLs.** Only `https:` URLs on public internet addresses are fetched.
A URL that points at a private, loopback or link-local address is refused, and
so is a redirect to one; each redirect is checked again, and the address is
checked once more at the moment of connecting.

**Stored results.** A result is stored only when the scan was made with a live
key under a non-zero retention window, and only until that window ends. Under a
sandbox key nothing is stored, so `getScan` and `deleteScan` answer "not found"
and `listScans` is empty.

## Errors

A failed call throws a `DocCheapError`. The AI SDK hands the message to the
model as the tool's error result, so the model can react to it. The error has
`status` – the HTTP status, or `null` when no answer came back – and `code`,
the API's own error code.

- **401 / 403** – the API key was refused.
- **429** – the rate limit or the sandbox allowance was reached: try later.
  The key itself is fine.
- **404** – the scan does not exist, or was never stored.
- `invalid_input` – the arguments were wrong, for example both `imageUrl` and
  `imageBase64`, or an image that is not JPEG or PNG.
- `image_refused` – the image URL could not be fetched or is not allowed.
- `network_error` – doc.cheap could not be reached.

Every request carries the header `User-Agent: doc-cheap-ai-sdk/<version>`, so
the API can tell calls made through this package from other callers. Nothing
else about your application is sent.

## Resources

- [Using doc.cheap with the AI SDK](https://doc.cheap/docs/guides/use-the-ai-sdk)
- [doc.cheap documentation](https://doc.cheap/docs)
- [Your first recognition](https://doc.cheap/docs/start/first-recognition)
- [API reference](https://doc.cheap/docs/reference)
- [Handling errors](https://doc.cheap/docs/guides/handle-errors)

## Version history

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)

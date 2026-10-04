# Changelog

## 0.1.1

- **docCheapTools()** can be passed straight as `tools` under strict
  TypeScript. Its return type was an interface, which the AI SDK's `ToolSet`
  record does not accept, so `tools: docCheapTools()` failed to compile and
  only `tools: { ...docCheapTools() }` worked. The type is now an object type
  alias; nothing changes at run time.

## 0.1.0

First release.

- **scanDocument** – recognises a passport, ID card or driving licence given
  as an `https:` image URL, base64 or a `data:` URL.
- **getScan**, **deleteScan** and **listScans** for stored scan results.
- **getUsage** for the account's credits and scan counters.
- **docCheapTools** – all five tools with one set of options.
- Image crops are kept out of the copy of a result the model sees.

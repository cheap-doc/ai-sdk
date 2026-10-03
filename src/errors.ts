/**
 * Every failure a doc.cheap tool throws. The AI SDK hands a thrown error to the
 * model as the tool's error result, so the message is written for whoever chose
 * the arguments to act on.
 *
 * `status` is the HTTP status when the API answered, otherwise null. `code` is
 * the API's own error code (`unsupported_document`, `not_found`, …), or one of
 * this package's codes when the request never got an answer: `invalid_input`,
 * `image_refused`, `network_error`, `invalid_response`.
 */
export class DocCheapError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(message: string, options: { readonly code: string; readonly status?: number }) {
    super(message);
    this.name = "DocCheapError";
    this.code = options.code;
    this.status = options.status ?? null;
  }
}

export function invalidInput(message: string): DocCheapError {
  return new DocCheapError(message, { code: "invalid_input" });
}

export function imageRefused(message: string): DocCheapError {
  return new DocCheapError(message, { code: "image_refused" });
}

// The shortest documented use: `docCheapTools()` passed straight as `tools`.
// The type check (`npm run typecheck`) compiles this file, so a declaration of
// the tool set that the AI SDK's `ToolSet` does not accept fails it; the test
// then runs the call through `generateText` with a scripted model and a fake
// API to show the tools work the same way when handed over directly.
import { generateText, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { type DocCheapTools, docCheapTools } from "./tools.ts";

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

// Assignability on its own, independent of how generateText infers its type
// parameter: the tool set must be usable wherever a `ToolSet` is asked for.
const asToolSet: (tools: DocCheapTools) => ToolSet = (tools) => tools;

describe("docCheapTools() as the tools of generateText", () => {
  it("is accepted without a spread and runs the tool the model calls", async () => {
    const seenUrls: string[] = [];
    const fakeApi = (async (url: string | URL) => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ balance: null }), { status: 200 });
    }) as typeof globalThis.fetch;

    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "getUsage", input: "{}" }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: USAGE,
        warnings: [],
      },
    });

    const result = await generateText({
      model,
      prompt: "How many credits are left?",
      tools: docCheapTools({
        baseUrl: "https://api.example.test",
        apiKey: "sk_test_key",
        fetch: fakeApi,
      }),
    });

    expect(seenUrls).toEqual(["https://api.example.test/v1/usage"]);
    expect(result.toolResults.map((r) => [r.toolName, r.output])).toEqual([
      ["getUsage", { balance: null }],
    ]);
    expect(Object.keys(asToolSet(docCheapTools()))).toHaveLength(5);
  });
});

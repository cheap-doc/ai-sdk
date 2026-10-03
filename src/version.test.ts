import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION, USER_AGENT } from "./version.ts";

describe("the version the package reports", () => {
  it("is the version in package.json", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(PACKAGE_VERSION).toBe(manifest.version);
    expect(USER_AGENT).toBe(`doc-cheap-ai-sdk/${manifest.version}`);
  });
});

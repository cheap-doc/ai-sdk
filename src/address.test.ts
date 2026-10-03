// The address rule behind imageUrl: which hosts a tool call may make this
// process fetch from. The resolver is injected, so no test touches DNS.
import { describe, expect, it } from "vitest";
import { assertAllowedImageUrl, assertAllowedUrlTarget, refuseAddress } from "./address.ts";
import { DocCheapError } from "./errors.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("refuseAddress", () => {
  it.each([
    ["0.1.2.3", "unspecified"],
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private-network"],
    ["172.16.0.1", "private-network"],
    ["172.31.255.255", "private-network"],
    ["192.168.1.1", "private-network"],
    ["169.254.169.254", "link-local"],
    ["100.64.0.1", "carrier-grade"],
    ["100.127.0.1", "carrier-grade"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
  ])("refuses the IPv4 address %s", (address, reason) => {
    expect(refuseAddress(address)).toContain(reason);
  });

  it.each([
    "93.184.216.34",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "100.63.0.1",
    "169.253.0.1",
  ])("allows the public IPv4 address %s", (address) => {
    expect(refuseAddress(address)).toBeNull();
  });

  it.each([
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::10.0.0.1", "private-network"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["fe80::1%en0", "link-local"],
    ["ff02::1", "multicast"],
  ])("refuses the IPv6 address %s", (address, reason) => {
    expect(refuseAddress(address)).toContain(reason);
  });

  it.each(["2606:4700::6810:85e5", "::ffff:93.184.216.34", "2001:db8:0:0:0:0:0:1", "::5db8:d822"])(
    "allows the public IPv6 address %s",
    (address) => {
      expect(refuseAddress(address)).toBeNull();
    },
  );

  it.each([
    "example.com",
    "1.2.3",
    "1.2.3.256",
    "1.2.3.x",
    "1::2::3",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "::ffff:1.2.3",
    "g::1",
    "::g",
    "1:2:3:4:5:6:7::8",
  ])("refuses %s, which is no IP address it can classify", (value) => {
    expect(refuseAddress(value)).toBe("not a recognizable IP address");
  });
});

describe("assertAllowedUrlTarget", () => {
  it("returns the parsed https URL", () => {
    expect(assertAllowedUrlTarget("https://doc.cheap/og-card.png").href).toBe(
      "https://doc.cheap/og-card.png",
    );
  });

  it("refuses text that is not a URL", () => {
    expect(() => assertAllowedUrlTarget("not a url")).toThrow(/not a valid URL/);
  });

  it.each(["http://doc.cheap/a.png", "file:///etc/passwd", "ftp://doc.cheap/a.png"])(
    "refuses the non-https URL %s",
    (url) => {
      expect(() => assertAllowedUrlTarget(url)).toThrow(/must be an https: URL/);
    },
  );

  it("refuses a private IP literal, v4 and v6", () => {
    expect(() => assertAllowedUrlTarget("https://127.0.0.1/a.png")).toThrow(/loopback/);
    expect(() => assertAllowedUrlTarget("https://[::1]/a.png")).toThrow(/loopback/);
  });

  it("allows a public IP literal", () => {
    expect(assertAllowedUrlTarget("https://93.184.216.34/a.png").hostname).toBe("93.184.216.34");
  });

  it("throws DocCheapError with the image_refused code", () => {
    let thrown: unknown;
    try {
      assertAllowedUrlTarget("http://doc.cheap/");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocCheapError);
    expect((thrown as DocCheapError).code).toBe("image_refused");
  });
});

describe("assertAllowedImageUrl", () => {
  it("allows a name that resolves to public addresses only", async () => {
    const url = await assertAllowedImageUrl("https://doc.cheap/og-card.png", publicLookup);
    expect(url.hostname).toBe("doc.cheap");
  });

  it("does not resolve an IP literal", async () => {
    const lookup = async () => {
      throw new Error("must not be called");
    };
    const url = await assertAllowedImageUrl("https://[2606:4700::6810:85e5]/a.png", lookup);
    expect(url.hostname).toBe("[2606:4700::6810:85e5]");
  });

  it("refuses a name that cannot be resolved", async () => {
    const lookup = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertAllowedImageUrl("https://nowhere.example.test/", lookup)).rejects.toThrow(
      /could not be resolved/,
    );
  });

  it("refuses a name that resolves to nothing", async () => {
    await expect(
      assertAllowedImageUrl("https://empty.example.test/", async () => []),
    ).rejects.toThrow(/resolved to no addresses/);
  });

  it("refuses a name when any one answer is private", async () => {
    const lookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await expect(assertAllowedImageUrl("https://mixed.example.test/", lookup)).rejects.toThrow(
      /resolves to 10\.0\.0\.5, which is a private-network address/,
    );
  });
});

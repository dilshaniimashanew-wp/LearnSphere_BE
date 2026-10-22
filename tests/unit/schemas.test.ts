import { describe, expect, it } from "vitest";
import { httpUrl, httpsUrl } from "../../src/shared/schemas.js";

describe("httpUrl", () => {
  it.each(["https://example.com/a?b=1", "http://localhost:3000/x"])("accepts %s", (v) => expect(httpUrl.safeParse(v).success).toBe(true));

  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "vbscript:x", "file:///etc/passwd", "ftp://x.test", "not a url", "", "//example.com"])(
    "rejects %j",
    (v) => expect(httpUrl.safeParse(v).success).toBe(false),
  );

  it("rejects absurdly long values", () => expect(httpUrl.safeParse(`https://x.test/${"a".repeat(2100)}`).success).toBe(false));
});

describe("httpsUrl", () => {
  it("only accepts https", () => {
    expect(httpsUrl.safeParse("https://example.com").success).toBe(true);
    expect(httpsUrl.safeParse("http://example.com").success).toBe(false);
  });
});

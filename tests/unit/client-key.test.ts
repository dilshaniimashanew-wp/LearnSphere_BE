import { describe, expect, it } from "vitest";
import { clientKey } from "../../src/middleware/security.js";

const SECRET = "a-shared-secret-123456";
const req = (headers: Record<string, string>, ip = "76.76.21.21") => ({ headers, ip }) as never;

describe("clientKey (rate-limit identity behind the web app proxy)", () => {
  it("uses the real visitor IP when the proxy proves it knows the shared secret", () => {
    expect(clientKey(req({ "x-client-ip": "203.0.113.9", "x-proxy-secret": SECRET }), SECRET)).toBe("203.0.113.9");
  });

  it("takes the first address if several are listed", () => {
    expect(clientKey(req({ "x-client-ip": "203.0.113.9, 10.0.0.1", "x-proxy-secret": SECRET }), SECRET)).toBe("203.0.113.9");
  });

  it("ignores a claimed IP without the secret, so clients cannot choose their own rate-limit bucket", () => {
    expect(clientKey(req({ "x-client-ip": "203.0.113.9" }), SECRET)).toBe("76.76.21.21");
  });

  it("ignores a claimed IP with the wrong secret", () => {
    expect(clientKey(req({ "x-client-ip": "203.0.113.9", "x-proxy-secret": "wrong-secret-1234567" }), SECRET)).toBe("76.76.21.21");
    expect(clientKey(req({ "x-client-ip": "203.0.113.9", "x-proxy-secret": "short" }), SECRET)).toBe("76.76.21.21");
  });

  it("never trusts the headers when no secret is configured", () => {
    expect(clientKey(req({ "x-client-ip": "203.0.113.9", "x-proxy-secret": SECRET }), undefined)).toBe("76.76.21.21");
  });

  it("groups IPv6 addresses by network so one person cannot dodge the limit by rotating addresses", () => {
    const a = clientKey(req({ "x-client-ip": "2001:db8:abcd:12:1111:2222:3333:4444", "x-proxy-secret": SECRET }), SECRET);
    const b = clientKey(req({ "x-client-ip": "2001:db8:abcd:12:ffff:eeee:dddd:cccc", "x-proxy-secret": SECRET }), SECRET);
    expect(a).toBe(b);
  });
});

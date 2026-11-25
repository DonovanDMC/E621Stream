import { describe, expect, test } from "bun:test";

import { fieldsToObject, objectToFields } from "../../src/db/Redis.ts";
import { flashHTML } from "../../src/http/Flash.ts";
import { changed, membership } from "../../src/ingester/updates.ts";
import { decrypt, encrypt } from "../../src/util/Encryption.ts";
import { compare, fingerprint } from "../../src/util/HMAC.ts";
import { pickRoute, type Route } from "../../src/util/Route.ts";
import { scrub } from "../../src/util/scrub.ts";
import { returnPath } from "../../src/util/util.ts";

test("stream fields keep their types", () => {
    const object = { a: "x:y", b: 1.5, c: false, d: { e: [1, null] }, f: null };
    expect(fieldsToObject(objectToFields(object))).toEqual(object);
});

test("encryption round trips, and each one is different", () => {
    const a = encrypt("secret"), b = encrypt("secret");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("secret");
    expect(() => decrypt(a.replace(/.$/, c => c === "0" ? "1" : "0"))).toThrow();
});

test("fingerprints", () => {
    expect(compare("token", fingerprint("token"))).toBe(true);
    expect(compare("other", fingerprint("token"))).toBe(false);
    expect(compare("token", null)).toBe(false);
    expect(compare("token", "abcd")).toBe(false);
});

test("returnPath only allows paths on the site", () => {
    expect(returnPath("/admin?x=1")).toBe("/admin?x=1");
    for (const value of ["//evil.test", "/\\evil.test", "https://evil.test", "admin", null, undefined]) expect(returnPath(value)).toBe("/user");
    expect(returnPath(null, "/")).toBe("/");
});

test("scrub removes keys at any depth without changing the original", () => {
    const value = { a: 1, email: "x", nested: [{ ip_addr: "y", b: 2 }] };
    expect(scrub(value, ["email", "ip_addr"]) as unknown).toEqual({ a: 1, nested: [{ b: 2 }] });
    expect(value.email).toBe("x");
});

describe("flashHTML", () => {
    test("allows a few tags and escapes the rest", () => {
        expect(flashHTML("<b>hi</b> <script>x</script>")).toBe("<b>hi</b> &lt;script&gt;x&lt;/script&gt;");
        expect(flashHTML("<b onclick=\"x\">hi</b>")).toBe("&lt;b onclick=&quot;x&quot;&gt;hi");
        expect(flashHTML("a<br>b<br/>")).toBe("a<br>b<br>");
    });

    test("closes what's left open", () => {
        expect(flashHTML("<b><i>hi")).toBe("<b><i>hi</i></b>");
        expect(flashHTML("<b><i>hi</b>")).toBe("<b><i>hi</i></b>");
        expect(flashHTML("hi</b>")).toBe("hi");
    });
});

describe("updates", () => {
    test("changed only counts fields the old copy has", () => {
        expect(changed(["name"], { name: "a" }, { name: "b" })).toBe(true);
        expect(changed(["name"], { name: "a" }, { name: "a" })).toBe(false);
        expect(changed(["name"], {}, { name: "b" })).toBe(false);
        expect(changed(["tags"], { tags: [1, 2] }, { tags: [1, 2] })).toBe(false);
        expect(changed(["name"], { name: "a" }, {})).toBe(true);
    });

    test("membership", () => {
        expect(membership([1, 2, 3], [2, 3, 4])).toEqual({ added: [4], removed: [1] });
        expect(membership(undefined, [1])).toEqual({ added: [1], removed: [] });
    });
});

describe("pickRoute", () => {
    const route = (name: string, inFlight = 0, downUntil = 0): Route => ({ name, proxy: name === "direct" ? null : `http://${name}`, inFlight, downUntil, failing: null });

    test("goes through the least busy, taking turns between ties", () => {
        const routes = [route("direct", 1), route("a"), route("b")];
        expect([0, 1, 2].map(turn => pickRoute(routes, turn).name)).toEqual(["a", "b", "a"]);
    });

    test("skips ones that are down", () => {
        expect(pickRoute([route("direct", 5), route("a", 0, Date.now() + 1000)], 0).name).toBe("direct");
    });
});

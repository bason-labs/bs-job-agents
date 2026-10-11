import { ApiErrorSchema, CSRF_HEADER } from "@bs-job-agents/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerErrorHandling } from "./http.js";
import { registerSecurity, loopbackHosts } from "./security.js";

const PORT = 4100;
const HOST = `127.0.0.1:${PORT}`;
const WEB = "http://localhost:3000";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  registerErrorHandling(app);
  registerSecurity(app, { port: () => PORT, webOrigins: [WEB, "http://127.0.0.1:3000"] });
  app.get("/thing", async () => ({ ok: true }));
  app.post("/thing", async (req) => ({ ok: true, body: req.body ?? null }));
  app.delete("/thing", async () => ({ ok: true }));
  // Like the uploads route: a multipart parser only in its own (encapsulated) context.
  await app.register(async (child) => {
    child.addContentTypeParser("multipart/form-data", (_req, payload, done) => {
      payload.resume();
      payload.on("end", () => done(null, {}));
    });
    child.post("/upload", { config: { multipart: true } }, async () => ({ ok: true }));
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const json = { "content-type": "application/json" };
const csrf = { [CSRF_HEADER]: "1" };

function refused(res: { statusCode: number; json(): unknown }, status: number, code: string) {
  expect(res.statusCode).toBe(status);
  const body = ApiErrorSchema.parse(res.json());
  expect(body.error.code).toBe(code);
}

describe("Host check (DNS rebinding, S18)", () => {
  it("answers 127.0.0.1, localhost and [::1] on the API's port", async () => {
    expect(loopbackHosts(PORT)).toEqual(new Set([HOST, `localhost:${PORT}`, `[::1]:${PORT}`]));
    for (const host of loopbackHosts(PORT)) {
      const res = await app.inject({ method: "GET", url: "/thing", headers: { host } });
      expect(res.statusCode).toBe(200);
    }
  });

  it("refuses a foreign Host, a Host without the port and a missing Host", async () => {
    for (const host of ["evil.example:4100", "127.0.0.1", "localhost:80", "127.0.0.1:4101", "localhost.:4100"]) {
      refused(await app.inject({ method: "GET", url: "/thing", headers: { host } }), 403, "forbidden");
    }
  });

  it("refuses a request forwarded for a host that is not the web app (rebinding through the proxy)", async () => {
    refused(await app.inject({ method: "GET", url: "/thing", headers: { host: HOST, "x-forwarded-host": "evil.example:3000" } }), 403, "forbidden");
    const ok = await app.inject({ method: "GET", url: "/thing", headers: { host: HOST, "x-forwarded-host": "localhost:3000" } });
    expect(ok.statusCode).toBe(200);
  });
});

describe("Origin check (S18)", () => {
  it("accepts the web app's origins and no Origin at all on reads", async () => {
    for (const origin of [WEB, "http://127.0.0.1:3000"]) {
      expect((await app.inject({ method: "GET", url: "/thing", headers: { host: HOST, origin } })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "GET", url: "/thing", headers: { host: HOST } })).statusCode).toBe(200);
  });

  it("refuses any other origin, including null and the API's own", async () => {
    for (const origin of ["http://evil.example", "null", "http://localhost:3001", `http://${HOST}`, "https://localhost:3000"]) {
      refused(await app.inject({ method: "GET", url: "/thing", headers: { host: HOST, origin } }), 403, "forbidden");
    }
  });

  it("refuses a cross-site request even without an Origin (Sec-Fetch-Site)", async () => {
    refused(await app.inject({ method: "GET", url: "/thing", headers: { host: HOST, "sec-fetch-site": "cross-site" } }), 403, "forbidden");
    expect((await app.inject({ method: "GET", url: "/thing", headers: { host: HOST, "sec-fetch-site": "same-origin" } })).statusCode).toBe(200);
  });

  it("never sends CORS headers, and a preflight gets none", async () => {
    const get = await app.inject({ method: "GET", url: "/thing", headers: { host: HOST, origin: WEB } });
    expect(get.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await app.inject({
      method: "OPTIONS",
      url: "/thing",
      headers: { host: HOST, origin: "http://evil.example", "access-control-request-method": "POST" },
    });
    expect(pre.statusCode).toBeGreaterThanOrEqual(400);
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("CSRF and JSON-only bodies (S18)", () => {
  it("accepts a JSON mutation from the web app with the CSRF header", async () => {
    const res = await app.inject({ method: "POST", url: "/thing", headers: { host: HOST, origin: WEB, ...json, ...csrf }, payload: { a: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, body: { a: 1 } });
  });

  it("refuses a cross-origin HTML form POST", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/thing",
      headers: { host: HOST, origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
      payload: "a=1",
    });
    refused(res, 403, "forbidden");
  });

  it("refuses a same-origin form POST without the CSRF header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/thing",
      headers: { host: HOST, origin: WEB, "content-type": "application/x-www-form-urlencoded" },
      payload: "a=1",
    });
    refused(res, 403, "forbidden");
  });

  it("PM3 M2: refuses every mutation without an Origin, even with the CSRF header (curl, Node fetch, a bot's REPL)", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/thing", headers: { host: HOST, ...csrf, ...json }, payload: { a: 1 } });
      refused(res, 403, "forbidden");
      expect(res.json().error.message).toBe("a state-changing request needs the web app's Origin; only the web app may change anything");
    }
    refused(await app.inject({ method: "DELETE", url: "/thing", headers: { host: HOST, ...csrf, "sec-fetch-site": "same-origin" } }), 403, "forbidden");
  });

  it("refuses every mutation without the CSRF header, even JSON and bodyless ones", async () => {
    refused(await app.inject({ method: "POST", url: "/thing", headers: { host: HOST, ...json }, payload: { a: 1 } }), 403, "forbidden");
    refused(await app.inject({ method: "DELETE", url: "/thing", headers: { host: HOST } }), 403, "forbidden");
    refused(await app.inject({ method: "POST", url: "/thing", headers: { host: HOST, [CSRF_HEADER]: "yes" }, payload: "" }), 403, "forbidden");
  });

  it("refuses a body that is not JSON (text/plain, form, multipart) with 415", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      refused(await app.inject({ method: "POST", url: "/thing", headers: { host: HOST, origin: WEB, ...csrf, "content-type": type }, payload: "a=1" }), 415, "validation_failed");
    }
  });

  it("accepts a bodyless mutation and an empty JSON body", async () => {
    expect((await app.inject({ method: "DELETE", url: "/thing", headers: { host: HOST, origin: WEB, ...csrf } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/thing", headers: { host: HOST, origin: WEB, ...csrf, ...json }, payload: "" })).statusCode).toBe(200);
  });

  it("takes multipart only where the route says so", async () => {
    const multipart = { "content-type": "multipart/form-data; boundary=x" };
    expect((await app.inject({ method: "POST", url: "/upload", headers: { host: HOST, origin: WEB, ...csrf, ...multipart }, payload: "--x--" })).statusCode).toBe(200);
    refused(await app.inject({ method: "POST", url: "/upload", headers: { host: HOST, origin: WEB, ...csrf, ...json }, payload: {} }), 415, "validation_failed");
  });

  it("refuses JSON with a __proto__ key (prototype poisoning)", async () => {
    const res = await app.inject({ method: "POST", url: "/thing", headers: { host: HOST, origin: WEB, ...csrf, ...json }, payload: '{"__proto__":{"admin":true}}' });
    expect(res.statusCode).toBe(400);
  });
});

describe("security headers", () => {
  it("sets nosniff, no-store, no referrer, same-origin resources and a closed CSP on every response", async () => {
    for (const res of [
      await app.inject({ method: "GET", url: "/thing", headers: { host: HOST } }),
      await app.inject({ method: "GET", url: "/thing", headers: { host: "evil.example" } }),
      await app.inject({ method: "GET", url: "/nope", headers: { host: HOST } }),
    ]) {
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    }
  });

  it("answers an unknown route with the shared 404 body", async () => {
    refused(await app.inject({ method: "GET", url: "/nope", headers: { host: HOST } }), 404, "not_found");
  });
});

"use strict";

const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const test = require("node:test");

const { createServer } = require("../src/server");

function dispatch(server, { method = "GET", url = "/", body = "" } = {}) {
  return new Promise((resolve) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = url;

    const response = { statusCode: null, headers: null, body: "" };
    const res = {
      writeHead(statusCode, headers = {}) {
        response.statusCode = statusCode;
        response.headers = headers;
      },
      end(value = "") {
        response.body = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
        resolve(response);
      },
    };

    server.emit("request", req, res);
  });
}

test("server parses boolean payloads, limits bodies, and sends security headers", async () => {
  const powerValues = [];
  const runtime = {
    async update(mutator) {
      mutator({ setPower: (value) => powerValues.push(value) });
      return { ok: true };
    },
  };
  const manager = { get: () => runtime };
  const server = createServer(manager);

  const powerResponse = await dispatch(server, {
    method: "POST",
    url: "/api/aircos/test/power",
    body: JSON.stringify({ operation: "off" }),
  });
  assert.equal(powerResponse.statusCode, 200);
  assert.deepEqual(powerValues, [false]);

  const invalidResponse = await dispatch(server, {
    method: "POST",
    url: "/api/aircos/test/power",
    body: JSON.stringify({ power: "invalid" }),
  });
  assert.equal(invalidResponse.statusCode, 400);

  const largeResponse = await dispatch(server, {
    method: "POST",
    url: "/api/aircos/test/power",
    body: JSON.stringify({ value: "x".repeat(65_536) }),
  });
  assert.equal(largeResponse.statusCode, 413);

  const pageResponse = await dispatch(server);
  assert.equal(pageResponse.statusCode, 200);
  assert.match(pageResponse.headers["Content-Security-Policy"], /default-src 'self'/);
  assert.equal(pageResponse.headers["X-Content-Type-Options"], "nosniff");
});

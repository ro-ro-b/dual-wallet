// LOCAL FICTIONAL FAKE of one bound P4 backend behind Vercel Authentication,
// for the wallet's native-entrance browser fixture only. It is not Vercel,
// Studio or the real backend, and proves nothing about them. Like the real
// protection, it refuses every request without the deployment's workload
// token (`x-vercel-trusted-oidc-idp-token`, this run's fictional value) with
// a 401 and nothing else: a browser, a credential-free server fetch and a
// wrong token all get the same refusal, never a redirect. With the token it
// serves exactly the pinned Ticket face Studio H2 emitted
// (e2e/fixtures/p4-ticket-face/...) and forwards the face-runtime operations
// endpoint to the local fake Loyalty runtime, without the token.
//
// A second, plain loopback port is the TEST's own window: /health and the
// request log (path, method, whether the token was right, and whether the
// request carried a browser's cookies, Origin or Referer; a server fetch
// sends none of them). It is never a wallet destination.
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "..", "fixtures", "p4-ticket-face");
const port = Number(process.env.P4_BACKEND_PORT || 4371);
const controlPort = Number(process.env.P4_BACKEND_CONTROL_PORT || 4373);
const runtimeOrigin = process.env.P4_BACKEND_RUNTIME_ORIGIN || "";
const token = process.env.P4_BACKEND_OIDC_TOKEN || "";
if (!token) throw new Error("P4_BACKEND_OIDC_TOKEN is required");
const HEADER = "x-vercel-trusted-oidc-idp-token";
const OPERATIONS = "/api/product-face/v1/operations";
const FACE = /^\/face\/([a-z0-9.-]+)\/(\d+\.\d+\.\d+)\/([a-f0-9]{64})\/(.*)$/;
const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
};

let log = [];

function refuse(response) {
  // What Vercel Authentication answers a caller it does not trust.
  response.writeHead(401, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end("<!doctype html><title>Authentication Required</title>");
}

async function face(response, pathname) {
  const match = FACE.exec(pathname);
  const name = match?.[4] || "index.html";
  if (!match || name.includes("..") || !(path.extname(name) in TYPES)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(
      path.join(FIXTURES, match[1], match[2], match[3], name),
    );
    response.writeHead(200, {
      "content-type": TYPES[path.extname(name)],
      "cache-control": "no-store",
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
}

async function forward(request, response, body) {
  // Server to server only: the runtime refuses anything with an Origin.
  const answer = await fetch(`${runtimeOrigin}${OPERATIONS}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-tig-product-face-application": String(
        request.headers["x-tig-product-face-application"] || "",
      ),
    },
    body,
    redirect: "manual",
  }).catch(() => undefined);
  if (!answer) {
    response.writeHead(502).end();
    return;
  }
  response.writeHead(answer.status, {
    "content-type": answer.headers.get("content-type") || "application/json",
  });
  response.end(Buffer.from(await answer.arrayBuffer()));
}

createServer(
  {
    cert: readFileSync(process.env.P4_BACKEND_CERT || ""),
    key: readFileSync(process.env.P4_BACKEND_KEY || ""),
  },
  async (request, response) => {
    const url = new URL(request.url || "/", "https://localhost");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const presented = request.headers[HEADER];
    const authenticated = presented === token;
    log.push({
      method: request.method,
      path: url.pathname,
      authenticated,
      token:
        presented === undefined
          ? "missing"
          : authenticated
            ? "this run's"
            : "wrong",
      browser: Boolean(
        request.headers.cookie ||
        request.headers.origin ||
        request.headers.referer,
      ),
    });
    if (!authenticated) return refuse(response);
    if (request.method === "GET" && url.pathname.startsWith("/face/")) {
      return face(response, url.pathname);
    }
    if (request.method === "POST" && url.pathname === OPERATIONS) {
      return forward(request, response, body);
    }
    response.writeHead(404).end();
  },
).listen(port, "localhost");

createHttpServer((request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  const json = (value) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (url.pathname === "/health") return json({ ok: true });
  if (url.pathname === "/__test__/requests") return json(log);
  if (url.pathname === "/__test__/reset") {
    log = [];
    return json({ ok: true });
  }
  response.writeHead(404).end();
}).listen(controlPort, "localhost");

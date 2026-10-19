// LOCAL FICTIONAL FAKE of the shared Tickets service's ticket-admission-v1 leg
// (docs/development/p4-3-admission-contract.md §5), for the wallet's browser
// fixture only. It is not Studio's runtime and proves nothing about it: it
// lets the real wallet (BFF, journal, native page, executor, /api/backend)
// run end to end against made-up data. Bound to loopback (localhost) only.
//
// It does what the contract asks of the real service at its boundary: every
// call must carry a one-time EdDSA face assertion signed by this run's wallet
// key, for this application and origin, naming the operation, op_id, target
// and the request hash of exactly the body; the holder is the assertion's.
import { createHash, createPublicKey, verify } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.FAKE_TICKETS_RUNTIME_PORT || 4330);
const apiOrigin =
  process.env.FAKE_TICKETS_API_ORIGIN || "http://127.0.0.1:4320";
const walletOrigin = process.env.FAKE_TICKETS_WALLET_ORIGIN || "";
const application = process.env.FAKE_TICKETS_APPLICATION || "";
const runtimeOrigin = process.env.FAKE_TICKETS_RUNTIME_ORIGIN || "";
const publicKey = createPublicKey(process.env.FACE_ASSERTION_PUBLIC_KEY || "");

const BIRTH_OPERATION = `op_${"b".repeat(40)}`;
const BIRTH_KEY = `tig:dual-operation:${"b".repeat(64)}`;

function canonicalJson(value) {
  if (value === null) return "null";
  if (["string", "boolean", "number"].includes(typeof value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
const hex = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value) => `sha256:${hex(canonicalJson(value))}`;

const seen = new Set();
let mode = { loseVerify: false };
// Per object: the open gate request, its proposal and reservation, admission.
const tickets = new Map();
const stateOf = (objectId) => {
  if (!tickets.has(objectId)) tickets.set(objectId, {});
  return tickets.get(objectId);
};

function verifyAssertion(body) {
  const [header, payload, signature] = String(body.assertion || "").split(".");
  if (!header || !payload || !signature) return null;
  const valid = verify(
    null,
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  if (!valid) return null;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  const ok =
    claims.iss === walletOrigin &&
    claims.aud ===
      `${application}@${runtimeOrigin.replace("127.0.0.1", "localhost")}` &&
    claims.operation === body.operation &&
    claims.op_id === body.operationId &&
    canonicalJson(claims.target) === canonicalJson(body.target) &&
    claims.request_hash ===
      sha({
        operation: body.operation,
        operationId: body.operationId,
        target: body.target,
        input: body.input,
      }) &&
    claims.exp > now &&
    !seen.has(claims.jti) &&
    /^0x[0-9a-f]{40}$/.test(claims.holder);
  if (!ok) return null;
  seen.add(claims.jti);
  return claims;
}

async function dualObject(objectId) {
  const response = await fetch(`${apiOrigin}/__test__/objects/${objectId}`);
  return response.ok ? response.json() : null;
}

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

function admissionMap(custom, requestId) {
  const digest = hex(`${requestId}|${custom.activation_hash}`);
  return {
    ...custom,
    state: "Admitted",
    admissionStatus: "Admitted",
    operation_id: `op_${digest.slice(0, 40)}`,
    idempotency_key: `tig:dual-operation:${digest}`,
  };
}

async function operate(body, claims) {
  const objectId = body.target?.object_id;
  const object = await dualObject(objectId);
  if (!object || String(object.owner).toLowerCase() !== claims.holder) {
    return [404, { ok: false, status: "admission_not_found" }];
  }
  const ticket = stateOf(objectId);
  const request = ticket.request
    ? {
        request_id: ticket.request.id,
        event_ref: object.custom.eventRef,
        created_at: ticket.request.createdAt,
        expires_at: ticket.request.expiresAt,
      }
    : null;
  const verifiedNow = () =>
    ticket.admitted &&
    canonicalJson(object.custom) ===
      canonicalJson(ticket.proposal.input.data.custom);
  const receipt = () => ({
    request_id: ticket.request.id,
    object_id: objectId,
    action_id: ticket.admitted.actionId,
    admitted_at: ticket.admitted.at,
    receipt_id: `rcpt-${ticket.request.id.slice(4, 12)}`,
    readback: {
      state: "Admitted",
      admission_status: "Admitted",
      operation_id: ticket.proposal.input.data.custom.operation_id,
      idempotency_key: ticket.proposal.input.data.custom.idempotency_key,
    },
  });
  switch (body.operation) {
    case "ticket.pass.read":
      return [
        200,
        {
          ok: true,
          status: "ticket_pass_ready",
          object_id: objectId,
          pass: {
            schema_version: "tig-ticket-pass-code-v1",
            code: `DT1.${object.custom.recordId}.${hex(objectId).slice(0, 20)}`,
          },
          issuance: {
            schema_version: "ticket-issuance-proof-v1",
            record_id: object.custom.recordId,
            object_id: objectId,
            activation_hash: object.custom.activation_hash,
            birth_operation_id: BIRTH_OPERATION,
            birth_idempotency_key: BIRTH_KEY,
            birth_action_id: "act-mint-fictional-0001",
            evidence: {
              birth_action: "verified",
              activation_hash: "verified",
              operation_commitment: "verified",
              operation_readback:
                object.custom.operation_id === BIRTH_OPERATION
                  ? "current"
                  : "superseded",
            },
          },
        },
      ];
    case "admission.pending.read":
      if (ticket.admitted) {
        return verifiedNow()
          ? [
              200,
              {
                ok: true,
                object_id: objectId,
                status: "admitted",
                admission: receipt(),
              },
            ]
          : [
              200,
              {
                ok: true,
                object_id: objectId,
                status: "admission_unverified",
                request,
              },
            ];
      }
      if (!request)
        return [200, { ok: true, object_id: objectId, status: "none" }];
      return [
        200,
        {
          ok: true,
          object_id: objectId,
          status:
            Date.parse(request.expires_at) > Date.now()
              ? "awaiting_holder"
              : "expired",
          request,
        },
      ];
    case "admission.propose": {
      if (
        !request ||
        body.input.request_id !== request.request_id ||
        ticket.reserved
      )
        return [
          409,
          {
            ok: false,
            status: "admission_request_mismatch",
            holder_dispatch: ticket.reserved ? "reserved" : "none",
          },
        ];
      if (!ticket.proposal) {
        const input = {
          data: { custom: admissionMap(object.custom, request.request_id) },
        };
        ticket.proposal = {
          proposal_id: `adp-${request.request_id.slice(4, 16)}`,
          request_id: request.request_id,
          object_id: objectId,
          action: "update",
          input,
          expires_at: request.expires_at,
          proposal_hash: sha({ object_id: objectId, action: "update", input }),
        };
      }
      return [200, { ok: true, status: "proposed", proposal: ticket.proposal }];
    }
    case "admission.reserve":
      if (ticket.reserved)
        return [
          409,
          {
            ok: false,
            status: "already_reserved",
            dispatch: "already_claimed",
            holder_dispatch: "reserved",
          },
        ];
      ticket.reserved = body.operationId;
      return [
        200,
        {
          ok: true,
          status: "granted",
          dispatch: "won",
          holder_dispatch: "reserved",
          reservation: {
            admission_operation_id: body.operationId,
            object_id: objectId,
            proposal_id: ticket.proposal.proposal_id,
            request_id: ticket.request.id,
          },
        },
      ];
    case "admission.verify":
    case "admission.status": {
      if (ticket.reserved !== body.operationId)
        return [
          409,
          {
            ok: false,
            status: "admission_reservation_required",
            holder_dispatch: "none",
          },
        ];
      if (
        canonicalJson(object.custom) !==
        canonicalJson(ticket.proposal.input.data.custom)
      )
        return [
          202,
          { ok: false, status: "outcome_unknown", holder_dispatch: "reserved" },
        ];
      ticket.admitted ??= {
        actionId: body.input.action_id || "act-admit-fictional",
        at: new Date().toISOString(),
      };
      return [
        200,
        {
          ok: true,
          status: "admitted",
          holder_dispatch: "verified",
          admission: receipt(),
        },
      ];
    }
    default:
      return [400, { ok: false, status: "face_request_invalid" }];
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health")
    return json(response, 200, { ok: true });
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
    : {};
  // Test hooks (local fake only): staff open a gate request; lose a reply.
  if (request.method === "POST" && url.pathname === "/__test__/gate-request") {
    const id = `tad-${hex(`${body.object_id}|${Date.now()}`).slice(0, 32)}`;
    tickets.set(body.object_id, {
      request: {
        id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    });
    return json(response, 200, { request_id: id });
  }
  if (request.method === "POST" && url.pathname === "/__test__/mode") {
    mode = { ...mode, ...body };
    return json(response, 200, mode);
  }
  if (request.method === "POST" && url.pathname === "/__test__/reset") {
    tickets.clear();
    mode = { loseVerify: false };
    return json(response, 200, { ok: true });
  }
  if (
    request.method !== "POST" ||
    url.pathname !== "/api/product-face/v1/operations"
  )
    return json(response, 404, {});
  // Server to server only.
  if (request.headers.origin)
    return json(response, 403, {
      ok: false,
      status: "face_trusted_read_server_only",
    });
  const claims = verifyAssertion(body);
  if (!claims)
    return json(response, 403, { ok: false, status: "face_assertion_invalid" });
  const [status, answer] = await operate(body, claims);
  if (mode.loseVerify && body.operation === "admission.verify") {
    request.socket.destroy();
    return;
  }
  return json(response, status, answer);
}).listen(port, "localhost");

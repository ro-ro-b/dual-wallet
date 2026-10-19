// LOCAL FICTIONAL FAKE of the Studio Loyalty runtime's loyalty-join-earn-v1
// leg (docs/proposals/loyalty-join-earn-v1.md §4), for the wallet's browser
// fixture only. It is not Studio and proves nothing about it: it lets the
// real wallet (BFF, journal, assertions, proofs, native page) run end to end
// against made-up data. Bound to loopback (localhost) only.
//
// Like the contract asks of the real runtime: every call needs a one-time
// EdDSA face assertion signed by this run's wallet key, for this application
// and origin, naming the operation, op_id, target and the request hash of
// exactly the body. Join and approval write nothing to Dual; the issuer's
// writes go through the fake API's world (e2e/loyalty/world.mjs).
import { createHash, createPublicKey, verify } from "node:crypto";
import { createServer } from "node:http";
import {
  CANON,
  CANON_TEMPLATE,
  ISSUER,
  MODEL_ID,
  PASS,
  PASS_TEMPLATE,
  PROGRAMME_ID,
  RECORD_ID,
} from "./environment.mjs";

const port = Number(process.env.FAKE_LOYALTY_RUNTIME_PORT || 4350);
const apiOrigin = process.env.FAKE_LOYALTY_API_ORIGIN || "";
const walletOrigin = process.env.FAKE_LOYALTY_WALLET_ORIGIN || "";
const application = process.env.FAKE_LOYALTY_APPLICATION || "";
const runtimeOrigin = process.env.FAKE_LOYALTY_RUNTIME_ORIGIN || "";
const organization = process.env.FAKE_LOYALTY_ORGANIZATION || "";
const publicKey = createPublicKey(process.env.FACE_ASSERTION_PUBLIC_KEY || "");
const PURPOSE = "membership-loyalty-rewards";

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
const sha = (value) => `sha256:${hex(value)}`;
const zero = (reason) => ({ dual_writes: 0, reason });

const seen = new Set();
let state;
function reset() {
  state = {
    join: null,
    holder: null,
    member: null,
    approval: "pending",
    opening: null,
    pass: false,
    submissions: new Map(),
    counts: {},
    /** Every operation this runtime received, in order, by its id. */
    received: [],
    mode: { loseSubmit: false },
  };
}
reset();

const PROGRAMME = {
  model_id: MODEL_ID,
  programme_id: PROGRAMME_ID,
  revision_hash: sha("fictional-revision-1"),
  name: "Harbour Makers Circle (fictional)",
  headline: "Make, learn and unlock studio time",
  member_promise: "Verified workshops count towards studio time.",
  terms_version: "HMC-2026-1",
  consent_statement:
    "I agree that my verified workshops are recorded for this fictional programme.",
  data_use: "Recorded only for this fictional programme.",
  activities: [
    {
      activity_type: "workshop",
      label: "Workshop attendance",
      evidence_hint: "Your workshop sign-in number",
    },
  ],
};
PROGRAMME.consent_fingerprint = sha(
  canonicalJson([
    PROGRAMME.terms_version,
    PROGRAMME.consent_statement,
    PROGRAMME.data_use,
  ]),
);

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
    claims.aud === `${application}@${runtimeOrigin}` &&
    claims.operation === body.operation &&
    claims.op_id === body.operationId &&
    canonicalJson(claims.target) === canonicalJson(body.target) &&
    body.target?.model_id === MODEL_ID &&
    claims.request_hash ===
      sha(
        canonicalJson({
          operation: body.operation,
          operationId: body.operationId,
          target: body.target,
          input: body.input,
        }),
      ) &&
    claims.exp > now &&
    !seen.has(claims.jti) &&
    /^0x[0-9a-f]{40}$/.test(claims.holder) &&
    typeof claims.sub === "string";
  if (!ok) return null;
  seen.add(claims.jti);
  return claims;
}

async function act(object_id, name, written, init) {
  const response = await fetch(`${apiOrigin}/__test__/loyalty/act`, {
    method: "POST",
    body: JSON.stringify({ object_id, name, account: ISSUER, written, init }),
  });
  return response.json();
}

/** The runtime's authenticated exact read of the canonical record, now. */
async function canonicalRead() {
  const response = await fetch(
    `${apiOrigin}/__test__/loyalty/objects/${CANON}`,
  );
  const object = await response.json();
  return {
    object_id: object.id,
    template_id: object.template_id,
    org_id: object.org_id,
    owner: object.owner,
    nonce: object.nonce,
    state_hash: object.state_hash,
    content_hash: object.content_hash,
    custom: object.custom,
    read: "authenticated_exact",
    read_at: new Date().toISOString(),
  };
}

const base = (lifecycleState) => ({
  generic_semantic_purpose: PURPOSE,
  recordId: RECORD_ID,
  title: "Harbour Makers Circle membership",
  programmeId: PROGRAMME_ID,
  memberReference: state.member,
  state: lifecycleState,
  tierStatus: "",
  eligibilitySummary: "",
  benefitReference: "",
  redemptionStatus: "",
});
const lifecycle = (semantic, eventId, lifecycleState) => ({
  lifecycle: {
    current_state: lifecycleState,
    target_state: lifecycleState,
    action_id: `${PURPOSE}_${semantic}_${eventId}`,
  },
});

async function operate(body, claims) {
  state.counts[body.operation] = (state.counts[body.operation] || 0) + 1;
  state.received.push({
    operation: body.operation,
    operationId: body.operationId,
  });
  const input = body.input || {};
  switch (body.operation) {
    case "loyalty.programme.read":
      return [
        200,
        {
          ok: true,
          status: "programme_open",
          programme: PROGRAMME,
          accounting: zero("programme_read"),
        },
      ];
    case "loyalty.join.request": {
      const consent = input.consent || {};
      if (consent.accepted !== true) {
        return [
          400,
          {
            ok: false,
            status: "consent_required",
            accounting: zero("consent_required"),
          },
        ];
      }
      if (
        consent.fingerprint !== PROGRAMME.consent_fingerprint ||
        consent.terms_version !== PROGRAMME.terms_version
      ) {
        return [
          409,
          {
            ok: false,
            status: "consent_changed",
            accounting: zero("consent_changed"),
          },
        ];
      }
      if (state.join) {
        return [
          409,
          {
            ok: false,
            status: "join_already_requested",
            accounting: zero("join_already_requested"),
          },
        ];
      }
      state.holder = claims.holder;
      // Studio's memberReference: sha256 of the member's Dual wallet id.
      state.member = sha(claims.sub);
      state.join = {
        request_id: `areq_${hex(body.operationId).slice(0, 24)}`,
        terms_version: PROGRAMME.terms_version,
        consent_hash: sha(`consent|${body.operationId}`),
        requested_at: new Date().toISOString(),
      };
      return [
        200,
        {
          ok: true,
          status: "join_requested",
          join: state.join,
          accounting: zero("join_request_recorded"),
        },
      ];
    }
    case "loyalty.membership.read": {
      const accounting = zero("membership_read");
      if (!state.join || state.holder !== claims.holder) {
        return [200, { ok: true, status: "none", accounting }];
      }
      if (!state.opening) {
        const status = {
          pending: "pending_approval",
          declined: "declined",
          approved: "pending_creation",
        }[state.approval];
        const reason = {
          pending: "join_pending_approval",
          declined: "join_declined",
          approved: "join_approved",
        }[state.approval];
        return [
          200,
          {
            ok: true,
            status,
            join: state.join,
            approval: {
              status: state.approval,
              ...(state.approval === "pending"
                ? {}
                : { decided_at: new Date().toISOString() }),
              accounting: zero(reason),
            },
            accounting,
          },
        ];
      }
      const canonical = await canonicalRead();
      if (!state.pass) {
        return [
          200,
          {
            ok: true,
            status: "pending_pass",
            canonical,
            opening: state.opening,
            accounting,
          },
        ];
      }
      return [
        200,
        {
          ok: true,
          status: "active",
          canonical,
          opening: state.opening,
          pass: { object_id: PASS, template_id: PASS_TEMPLATE },
          accounting,
        },
      ];
    }
    case "loyalty.activity.submit": {
      // Idempotent by operationId, looked up before every other check: an
      // operation it already holds is never refused or written again.
      if (state.submissions.has(body.operationId)) {
        return [
          409,
          {
            ok: false,
            status: "operation_already_received",
            accounting: zero("operation_already_received"),
          },
        ];
      }
      if (
        !state.pass ||
        state.holder !== claims.holder ||
        body.target.object_id !== CANON
      ) {
        return [
          409,
          {
            ok: false,
            status: "membership_not_active",
            accounting: zero("membership_not_active"),
          },
        ];
      }
      const evidenceHash = sha(String(input.evidence_ref));
      if (
        [...state.submissions.values()].some(
          (item) => item.submission.evidence_hash === evidenceHash,
        )
      ) {
        return [
          409,
          {
            ok: false,
            status: "loyalty_activity_evidence_duplicate",
            accounting: zero("loyalty_activity_evidence_duplicate"),
          },
        ];
      }
      const receipt = {
        ...(await act(CANON, "update", {
          ...base("Activity pending"),
          ...lifecycle("submit_activity", body.operationId, "Activity pending"),
          proof_event: {
            event_type: "submit_activity",
            public_fields: [
              "action:submit_activity",
              "state:Activity pending",
              `activityEvidenceHash:${evidenceHash}`,
            ],
          },
        })),
        semantic: "submit_activity",
      };
      const submission = {
        evidence_hash: evidenceHash,
        activity_type: input.activity_type,
        submitted_at: new Date().toISOString(),
      };
      state.submissions.set(body.operationId, { receipt, submission });
      return [
        200,
        {
          ok: true,
          status: "activity_submitted",
          submission,
          canonical: await canonicalRead(),
          action: receipt,
          accounting: { dual_writes: 1, reason: "activity_submitted" },
        },
      ];
    }
    case "loyalty.activity.status": {
      const held = state.submissions.get(body.operationId);
      if (!held) {
        return [
          200,
          {
            ok: true,
            status: "not_received",
            accounting: zero("operation_not_received"),
          },
        ];
      }
      return [
        200,
        {
          ok: true,
          status: held.verification ? "verified" : "submitted",
          submission: held.submission,
          canonical: await canonicalRead(),
          action: held.receipt,
          ...(held.verification ? { verification: held.verification } : {}),
        },
      ];
    }
    default:
      return [400, { ok: false, status: "face_request_invalid" }];
  }
}

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    return json(response, 200, { ok: true });
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
    : {};
  // Test hooks (local fake only): what Studio staff would do.
  if (request.method === "POST" && url.pathname.startsWith("/__test__/")) {
    switch (url.pathname) {
      case "/__test__/approve":
        state.approval = "approved";
        return json(response, 200, { ok: true });
      case "/__test__/create": {
        state.opening = {
          ...(await act(CANON, "mint", base("Member"), {
            template_id: CANON_TEMPLATE,
            owner: ISSUER,
            to: ISSUER,
            name: "Harbour Makers Circle membership",
          })),
          semantic: "create_membership",
        };
        if (body.pass !== false) {
          await act(
            PASS,
            "mint",
            {
              passType: "Membership opening acknowledgement",
              canonicalOpeningReference: sha(
                `opening|${state.opening.action_id}`,
              ),
              participantReference: sha(`participant|${state.member}`),
              openingState: "Member",
              openingSnapshotHash: sha("fictional-snapshot"),
              acknowledgement:
                "This pass acknowledges one verified membership opening. Check the programme record for current membership.",
              schema: "participant-opening-pass-v1",
              product_type: "participant_opening_pass",
              canonical_object_id: CANON,
              canonical_template_id: CANON_TEMPLATE,
              canonical_issuer_account: ISSUER,
              organization_id: organization,
              opening_action_id: state.opening.action_id,
              opening_snapshot_hash: sha("fictional-snapshot"),
              activation_hash: hex("fictional-pass"),
              idempotency_key: sha("fictional-pass-key"),
              operation_id: state.opening.action_id,
            },
            {
              template_id: PASS_TEMPLATE,
              owner: state.holder,
              to: state.holder,
              name: "Membership pass",
            },
          );
          state.pass = true;
        }
        return json(response, 200, {
          ok: true,
          opening: state.opening.action_id,
        });
      }
      case "/__test__/verify": {
        const pending = [...state.submissions.entries()].find(
          ([, item]) => !item.verification,
        );
        if (!pending) return json(response, 409, { ok: false });
        const [operationId, held] = pending;
        held.verification = {
          ...(await act(CANON, "update", {
            ...base("Activity verified"),
            ...lifecycle("verify_activity", operationId, "Activity verified"),
            proof_event: {
              event_type: "verify_activity",
              public_fields: [
                "action:verify_activity",
                "state:Activity verified",
              ],
            },
          })),
          semantic: "verify_activity",
        };
        return json(response, 200, { ok: true });
      }
      case "/__test__/mode":
        state.mode = { ...state.mode, ...body };
        return json(response, 200, state.mode);
      case "/__test__/counts":
        return json(response, 200, state.counts);
      case "/__test__/received":
        return json(response, 200, state.received);
      case "/__test__/reset":
        reset();
        return json(response, 200, { ok: true });
    }
  }
  if (
    request.method !== "POST" ||
    url.pathname !== "/api/product-face/v1/operations"
  ) {
    return json(response, 404, {});
  }
  // Server to server only.
  if (request.headers.origin) {
    return json(response, 403, {
      ok: false,
      status: "face_trusted_read_server_only",
    });
  }
  const claims = verifyAssertion(body);
  if (!claims)
    return json(response, 403, { ok: false, status: "face_assertion_invalid" });
  const [status, answer] = await operate(body, claims);
  if (state.mode.loseSubmit && body.operation === "loyalty.activity.submit") {
    state.mode.loseSubmit = false;
    // The write happened; the reply is lost.
    request.socket.destroy();
    return;
  }
  return json(response, status, answer);
}).listen(port, "localhost");

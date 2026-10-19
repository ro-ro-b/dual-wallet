// LOCAL FAKE of the api-v3 surface the wallet e2e suites use. It is not Dual:
// it keeps a tiny in-memory object store, never signs anything and is only
// ever bound to 127.0.0.1. The product-face suite additionally uses the
// programme objects below and the `/__test__/*` hooks.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  ADMISSION_TEMPLATE,
  ADMISSION_TICKET,
  OTHER_ORGANIZATION,
  TICKET_IDS,
  TICKET_TEMPLATE,
} from "./tickets-home/environment.mjs";

const expectedOrganizationId =
  process.env.DEFAULT_ORGANIZATION_ID || "000000000000000000000001";
const port = Number(process.env.MOCK_API_PORT || 4010);
// Integrated mode (contract.localHarness): programme-template object reads go
// to the Studio local fake Dual so both sides read one state.
const programmeDualUrl = process.env.MOCK_PROGRAMME_DUAL_URL || "";
const publicObjectId = "507f1f77bcf86cd799439011";
const publicObject = {
  id: publicObjectId,
  metadata: {
    name: "Sample Membership",
    description: "A verified membership object used by the Viewer E2E suite.",
    category: "Membership",
    edition: 7,
    image: {
      id: "image-e2e-1",
      url: "/og-viewer.png",
      is_public: true,
    },
  },
  owner: "0x1234567890abcdef1234567890abcdef12345678",
  template_id: "507f1f77bcf86cd799439012",
  nonce: 1,
  version: 3,
  state_hash: "0xstatehash",
  content_hash: "0xcontenthash",
  integrity_hash: "0xintegrityhash",
  prev_integrity_hash: "0xprevintegrityhash",
  custom: { tier: "founder" },
  when_created: "2026-01-10T10:00:00.000Z",
  when_modified: "2026-02-12T12:30:00.000Z",
};

// ---------------------------------------------------------------- programme

export const PROGRAMME = {
  walletId: "wallet-face-e2e",
  // The Studio harness's default --holder-wallet, so integrated mode agrees.
  walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
  controllerAddress: "0x00000000000000000000000000000000000c0de1",
  issuerAddress: "0x00000000000000000000000000000000000155ae",
  morrowTemplate: "6a0000000000000000000001",
  tidewellTemplate: "6a0000000000000000000002",
  unitA: "6a00000000000000000000a1",
  unitB: "6a00000000000000000000b2",
  ownedA: "6a00000000000000000000c3",
  ownedB: "6a00000000000000000000d4",
  tidewellKettle: "6a00000000000000000000e5",
  email: "face-e2e@example.com",
  password: "correct horse battery staple",
};

// A second fictional account, used only to prove that a pending face
// handover never crosses accounts (contract r14). It owns nothing.
export const SECOND_ACCOUNT = {
  walletId: "wallet-face-e2e-b",
  nickname: "Face E2E B",
  walletAddress: "0x00000000000000000000000000000000000000b2",
  email: "face-e2e-b@example.com",
  password: "another correct horse battery",
};

// Morrow units carry a full specification sheet, so the holder settle
// proposal (the COMPLETE custom map) has 35 leaves.
export const SPEC_FIELDS = Array.from(
  { length: 27 },
  (_, index) => `spec_${String(index + 1).padStart(2, "0")}`,
);
const specSheet = (serial) =>
  Object.fromEntries(
    SPEC_FIELDS.map((field, index) => [
      field,
      `${serial} specification line ${index + 1} (local fake value)`,
    ]),
  );

function programmeObject(id, { owner, template, name, serial, state }) {
  return {
    id,
    org_id: expectedOrganizationId,
    metadata: {
      name,
      description: `${name} (local fake)`,
      category: "Product",
    },
    owner,
    template_id: template,
    nonce: 1,
    version: 1,
    state_hash: `0x${id}`,
    content_hash: `0x${id}`,
    integrity_hash: `0x${id}`,
    prev_integrity_hash: `0x${id}`,
    custom: {
      // Matches the fixture runtime's evidence units (rec-<last four>), so the
      // host's r6 record_id check sees the same Passport record.
      recordId: `rec-${id.slice(-4)}`,
      title: name,
      serialNumber: serial,
      model: "ARC-G1",
      manufacturer: "Morrow Home",
      state,
      ...specSheet(serial),
    },
    when_created: "2026-09-01T09:00:00.000Z",
    when_modified: "2026-09-01T09:00:00.000Z",
  };
}

function seedProgramme() {
  const objects = new Map();
  const add = (object) => objects.set(object.id, object);
  add(
    programmeObject(PROGRAMME.unitA, {
      owner: PROGRAMME.issuerAddress,
      template: PROGRAMME.morrowTemplate,
      name: "Arc grinder",
      serial: "MH-ARC-0001",
      state: "Issued",
    }),
  );
  add(
    programmeObject(PROGRAMME.unitB, {
      owner: PROGRAMME.issuerAddress,
      template: PROGRAMME.morrowTemplate,
      name: "Arc grinder",
      serial: "MH-ARC-0002",
      state: "Issued",
    }),
  );
  add(
    programmeObject(PROGRAMME.ownedA, {
      owner: PROGRAMME.walletAddress,
      template: PROGRAMME.morrowTemplate,
      name: "Arc grinder",
      serial: "MH-ARC-0101",
      state: "Registered",
    }),
  );
  add(
    programmeObject(PROGRAMME.ownedB, {
      owner: PROGRAMME.walletAddress,
      template: PROGRAMME.morrowTemplate,
      name: "Morrow Arc grinder",
      serial: "MH-ARC-0102",
      state: "In service",
    }),
  );
  // A second brand's product: never part of the Morrow programme.
  add({
    ...programmeObject(PROGRAMME.tidewellKettle, {
      owner: PROGRAMME.walletAddress,
      template: PROGRAMME.tidewellTemplate,
      name: "Tidewell kettle",
      serial: "TW-K-0001",
      state: "Registered",
    }),
    custom: {
      title: "Tidewell kettle",
      serialNumber: "TW-K-0001",
      model: "TW-K",
      manufacturer: "Tidewell",
      state: "Registered",
    },
  });
  return objects;
}

// ------------------------------------------------- tickets (opt-in fixture)
// FICTIONAL event tickets for the Tickets/Home browser fixture
// (playwright.tickets-home.config.ts), seeded only when MOCK_TICKETS=1 so
// every other suite sees exactly the store it always has. Times are relative
// to when the store is seeded: "today" is the seeding instant itself, which is
// today in every time zone.
const ticketsFixture = process.env.MOCK_TICKETS === "1";
const TICKETS = {
  template: TICKET_TEMPLATE,
  otherOrganization: OTHER_ORGANIZATION,
  ...TICKET_IDS,
};
// "normal" | "emptyWithMore" (no ticket on any upstream page, always more) |
// "unavailable" (the list read fails). Changed only through /__test__.
let ticketsMode = "normal";
// When true every bearer request and refresh is refused: the session ended.
let ticketSessionsExpired = false;

function ticketObject(
  id,
  { owner, orgId = expectedOrganizationId, title, startsAt, state, issue },
) {
  return {
    id,
    org_id: orgId,
    metadata: { name: `${title} entry`, description: "Fictional ticket" },
    owner,
    template_id: TICKETS.template,
    nonce: 1,
    version: 1,
    state_hash: `0x${id}`,
    content_hash: `0x${id}`,
    integrity_hash: `0x${id}`,
    prev_integrity_hash: `0x${id}`,
    custom: {
      event: {
        title,
        ...(startsAt ? { starts_at: startsAt } : {}),
        venue: "Quay Hall (fictional)",
      },
      ticket: {
        class: "Standing",
        entry_guidance: "Doors open 30 minutes before the start.",
        state,
      },
      ...(issue ? { issue: { operation_id: issue } } : {}),
    },
    when_created: "2026-10-01T09:00:00.000Z",
    when_modified: "2026-10-01T09:00:00.000Z",
  };
}

function seedTickets(store) {
  const now = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const days = (count) =>
    new Date(now.getTime() + count * 86_400_000).toISOString();
  const holder = PROGRAMME.walletAddress;
  const add = (id, fields) => store.set(id, ticketObject(id, fields));
  add(TICKETS.today, {
    owner: holder,
    title: "Harbour Night",
    startsAt: now.toISOString(),
    state: "Issued",
    issue: "fx-issue-0001",
  });
  add(TICKETS.comingUp, {
    owner: holder,
    title: "Lantern Walk",
    startsAt: days(3),
    state: "Issued",
    issue: "fx-issue-0002",
  });
  add(TICKETS.pending, {
    owner: holder,
    title: "Pier Concert",
    startsAt: days(10),
    state: "Issuing",
    issue: "fx-issue-0003",
  });
  // No issue operation recorded: the wallet must not call it issued.
  add(TICKETS.unconfirmed, {
    owner: holder,
    title: "Dawn Swim",
    state: "Issued",
  });
  add(TICKETS.past, {
    owner: holder,
    title: "Winter Fair",
    startsAt: days(-3),
    state: "Issued",
    issue: "fx-issue-0005",
  });
  // The holder's, but issued by another organisation: never this client's.
  add(TICKETS.otherClient, {
    owner: holder,
    orgId: TICKETS.otherOrganization,
    title: "Other Client Gala",
    startsAt: days(1),
    state: "Issued",
    issue: "fx-issue-0006",
  });
  // This client's, but held by the second fictional account.
  add(TICKETS.otherHolder, {
    owner: SECOND_ACCOUNT.walletAddress,
    title: "Second Holder Night",
    startsAt: days(2),
    state: "Issued",
    issue: "fx-issue-0007",
  });
  return store;
}

// P4.3 admission fixture (MOCK_TICKETS_ADMISSION=1): one FICTIONAL ticket on
// the shared Tickets service's closed 16-key template, held by the holder.
const admissionFixture = process.env.MOCK_TICKETS_ADMISSION === "1";
function seedAdmissionTicket(store) {
  const now = Date.now();
  store.set(ADMISSION_TICKET, {
    id: ADMISSION_TICKET,
    org_id: expectedOrganizationId,
    metadata: { name: "Night Market entry", description: "Fictional ticket" },
    owner: PROGRAMME.walletAddress,
    template_id: ADMISSION_TEMPLATE,
    nonce: 1,
    version: 1,
    state_hash: `0x${ADMISSION_TICKET}`,
    content_hash: `0x${ADMISSION_TICKET}`,
    integrity_hash: `0x${ADMISSION_TICKET}`,
    prev_integrity_hash: `0x${ADMISSION_TICKET}`,
    custom: {
      accessClass: "Standing",
      activation_hash: "a".repeat(64),
      admissionStatus: "Valid",
      admissionWindowEndsAt: new Date(now + 4 * 3_600_000).toISOString(),
      // The current minute: always the viewer's own calendar day, in any
      // zone, so the home's Today shows it at whatever time the suite runs.
      admissionWindowStartsAt: new Date(
        Math.floor(now / 60_000) * 60_000,
      ).toISOString(),
      app_namespace: "fictional-tickets",
      eventRef: "night-market-fictional",
      idempotency_key: `tig:dual-operation:${"b".repeat(64)}`,
      operation_id: `op_${"b".repeat(40)}`,
      product_type: "event_ticket",
      recipient_mint_projection: true,
      recordId: "tkt-night-0001",
      seatRef: "",
      state: "Valid",
      title: "Night Market",
      venueRef: "Pier Shed (fictional)",
    },
    when_created: "2026-10-01T09:00:00.000Z",
    when_modified: "2026-10-01T09:00:00.000Z",
  });
  return store;
}

let objects = seedProgramme();
if (ticketsFixture) seedTickets(objects);
if (admissionFixture) seedAdmissionTicket(objects);
let actionLogs = [];
// Test mode: execute answers to drop after the action ran (a lost response).
let loseExecuteResponses = 0;
// Integrated mode: the templates the wallet registry binds live in the Studio
// fake Dual, so reads of their objects, and the holder's own settle execute,
// go there instead of this store.
const integratedTemplates = new Set(
  (() => {
    try {
      return JSON.parse(process.env.PRODUCT_FACE_APPLICATIONS || "[]").flatMap(
        (binding) => binding.templateIds ?? [],
      );
    } catch {
      return [];
    }
  })(),
);
const integrated = (objectId, templateId) =>
  Boolean(programmeDualUrl) &&
  ((templateId && integratedTemplates.has(templateId)) ||
    (objectId && !objects.has(objectId)));

// The account a bearer token names (`sub`); the programme holder otherwise.
function bearerAccount(request) {
  const match = /^Bearer\s+(\S+)/.exec(request.headers.authorization ?? "");
  try {
    const claims = JSON.parse(
      Buffer.from(
        String(match?.[1] ?? "").split(".")[1] ?? "",
        "base64url",
      ).toString("utf8"),
    );
    return claims.sub === SECOND_ACCOUNT.walletId
      ? SECOND_ACCOUNT.walletId
      : PROGRAMME.walletId;
  } catch {
    return PROGRAMME.walletId;
  }
}

function wallet(id = PROGRAMME.walletId) {
  const second = id === SECOND_ACCOUNT.walletId;
  return {
    id: second ? SECOND_ACCOUNT.walletId : PROGRAMME.walletId,
    nickname: second ? SECOND_ACCOUNT.nickname : "Face E2E",
    email: second ? SECOND_ACCOUNT.email : PROGRAMME.email,
    language: "en",
    fqdn: "demo.localhost",
    activated: true,
    email_verified: true,
    disabled: false,
    account: {
      address: second ? SECOND_ACCOUNT.walletAddress : PROGRAMME.walletAddress,
      type: "SMART_WALLET",
      controller: {
        address: PROGRAMME.controllerAddress,
        type: "SECP256K1",
        custody: "custodial",
      },
      smart_account: {
        chain_id: 1,
        factory: "0xfactory",
        implementation: "0ximplementation",
        index: 0,
        validator: "0xvalidator",
        validator_type: "ECDSA",
        version: "0.3.1",
      },
    },
    when_created: "2026-01-01T00:00:00.000Z",
    when_modified: "2026-01-01T00:00:00.000Z",
  };
}

function token(claims) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.fake`;
}

function login(id = PROGRAMME.walletId) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: token({
      org_id: expectedOrganizationId,
      exp: now + 3600,
      sub: id,
    }),
    refresh_token: token({
      exp: now + 7200,
      sub: id,
      nonce: randomBytes(6).toString("hex"),
    }),
    wallet: wallet(id),
  };
}

function actionLog(id, name, objectId, account, changeType = "update") {
  const when = new Date().toISOString();
  return {
    id,
    name,
    params: { id: objectId },
    message_hash: `0x${id}`,
    account,
    controller: account,
    hash: `0x${createHash("sha256").update(id).digest("hex").slice(0, 40)}`,
    affected_objects: [
      {
        id: objectId,
        template_id: objects.get(objectId)?.template_id,
        prev_state_hash: "0xprev",
        next_state_hash: "0xnext",
        prev_integrity_hash: "0xprev",
        integrity_hash: "0xnext",
        state_change_id: `${id}-change`,
        change_type: changeType,
      },
    ],
    status: "completed",
    base_fee: "0",
    base_fee_wei: "0",
    dynamic_fee: "0",
    dynamic_fee_wei: "0",
    token_price: "1",
    total_fee: "0 DUAL",
    total_fee_wei: "0",
    nonce: 1,
    auth: { type: "personal_sign", signature: "0xfake" },
    version: 2,
    when_created: when,
    when_modified: when,
  };
}

function mergeCustom(target, patch) {
  const result = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    result[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeCustom(
            result[key] && typeof result[key] === "object" ? result[key] : {},
            value,
          )
        : value;
  }
  return result;
}

// ------------------------------------------------------------------ helpers

function respond(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 256 * 1024) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(undefined);
      }
    });
  });
}

const authorized = (request) =>
  !(ticketsFixture && ticketSessionsExpired) &&
  /^Bearer\s+\S+/.test(request.headers.authorization ?? "");

function display(variant) {
  return {
    face_id: "507f1f77bcf86cd799439013",
    variant,
    media_type: "text/html",
    href: `/public/objects/${publicObjectId}/display/${variant}`,
    revision: `face-e2e-${variant}`,
    interactive: false,
  };
}

async function forwardProgramme(request, response, url, init = {}) {
  try {
    const upstream = await fetch(
      `${programmeDualUrl}${url.pathname}${url.search}`,
      { headers: { Accept: "application/json" }, ...init },
    );
    response.writeHead(upstream.status, {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/json",
    });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    respond(response, 502, { message: "Programme fake Dual unreachable" });
  }
}

async function handleProgramme(request, response, url) {
  const method = request.method;
  const path = url.pathname;

  // Test hooks for the product-face suite. Local fake only.
  if (method === "POST" && path === "/__test__/reset") {
    objects = seedProgramme();
    if (ticketsFixture) seedTickets(objects);
    if (admissionFixture) seedAdmissionTicket(objects);
    actionLogs = [];
    loseExecuteResponses = 0;
    return respond(response, 200, { ok: true });
  }
  if (ticketsFixture && method === "POST" && path === "/__test__/tickets") {
    const body = await readBody(request);
    if (body?.reset) {
      objects = seedTickets(seedProgramme());
      ticketsMode = "normal";
      ticketSessionsExpired = false;
    }
    if (["normal", "emptyWithMore", "unavailable"].includes(body?.mode)) {
      ticketsMode = body.mode;
    }
    if (typeof body?.expireSessions === "boolean") {
      ticketSessionsExpired = body.expireSessions;
    }
    return respond(response, 200, {
      mode: ticketsMode,
      expireSessions: ticketSessionsExpired,
    });
  }
  if (method === "POST" && path === "/__test__/mode") {
    const body = await readBody(request);
    loseExecuteResponses = Number(body?.loseExecuteResponses ?? 0) || 0;
    return respond(response, 200, { loseExecuteResponses });
  }
  // The fake runtime's read-only reconcile and the suites read these: who
  // executed what on which object (no auth; local fake only).
  if (method === "GET" && path === "/__test__/action-logs") {
    const objectId = url.searchParams.get("object_id");
    return respond(response, 200, {
      action_logs: actionLogs.filter(
        (log) =>
          !objectId || log.affected_objects.some((o) => o.id === objectId),
      ),
    });
  }
  if (method === "POST" && path === "/__test__/issuer-transfer") {
    const body = await readBody(request);
    const object = objects.get(body?.object_id);
    if (!object) return respond(response, 404, { message: "Not found" });
    object.owner = body.to;
    object.custom = mergeCustom(object.custom, {
      state: body.state,
      ...(body.lifecycle_target
        ? { lifecycle: { target_state: body.lifecycle_target } }
        : {}),
    });
    object.when_modified = new Date().toISOString();
    const id = `action-${randomBytes(6).toString("hex")}`;
    actionLogs.unshift(
      actionLog(id, "transfer", object.id, PROGRAMME.issuerAddress),
    );
    return respond(response, 200, { action_id: id, object });
  }
  if (method === "GET" && path.startsWith("/__test__/objects/")) {
    const object = objects.get(path.slice("/__test__/objects/".length));
    return object
      ? respond(response, 200, object)
      : respond(response, 404, { message: "Not found" });
  }

  if (method === "POST" && path === "/auth/login") {
    // A new sign-in starts a session the Tickets fixture has not expired.
    ticketSessionsExpired = false;
    const body = await readBody(request);
    if (body?.organization_id !== expectedOrganizationId) {
      return respond(response, 422, { message: "Unexpected organization" });
    }
    if (
      body.email === SECOND_ACCOUNT.email &&
      body.password === SECOND_ACCOUNT.password
    ) {
      return respond(response, 200, login(SECOND_ACCOUNT.walletId));
    }
    if (
      body.email !== PROGRAMME.email ||
      body.password !== PROGRAMME.password
    ) {
      return respond(response, 401, { message: "Invalid credentials" });
    }
    return respond(response, 200, login());
  }
  if (method === "POST" && path === "/auth/logout") {
    return respond(response, 200, {});
  }
  if (
    method === "POST" &&
    path === "/auth/refresh-token" &&
    ticketsFixture &&
    ticketSessionsExpired
  ) {
    return respond(response, 401, { message: "Refresh token expired" });
  }
  if (method === "POST" && path === "/auth/refresh-token") {
    const { access_token, refresh_token } = login(bearerAccount(request));
    return respond(response, 200, { access_token, refresh_token });
  }
  if (method === "GET" && path === "/wallets/me") {
    if (!authorized(request)) return respond(response, 401, {});
    return respond(response, 200, wallet(bearerAccount(request)));
  }

  const objectMatch =
    /^\/(public\/)?objects\/([0-9a-f]{24})(\/attributes)?$/.exec(path);
  if (method === "GET" && objectMatch) {
    const [, isPublic, objectId, attributes] = objectMatch;
    const object = objects.get(objectId);
    if (integrated(objectId, object?.template_id)) {
      if (!isPublic && !authorized(request)) return respond(response, 401, {});
      // The Studio fake Dual has no attribute store (local fake: empty list).
      if (attributes) return respond(response, 200, { attributes: [] });
      return forwardProgramme(
        request,
        response,
        new URL(`/objects/${objectId}`, url),
      );
    }
    if (!object) return undefined;
    if (!isPublic && !authorized(request)) return respond(response, 401, {});
    if (attributes) {
      return respond(response, 200, {
        attributes: [
          {
            id: `attribute-${objectId}`,
            object_id: objectId,
            key: "care.last_clean",
            value: "2026-09-20",
            content_type: "text",
            public: false,
            value_hash: "0xhash",
            action_id: "action-attribute",
            object_nonce: 1,
            when_created: "2026-09-20T00:00:00.000Z",
            when_modified: "2026-09-20T00:00:00.000Z",
          },
        ],
      });
    }
    return respond(response, 200, object);
  }

  if (method === "GET" && path === "/objects" && authorized(request)) {
    const templateId = url.searchParams.get("template_id");
    const owner = url.searchParams.get("owner")?.toLowerCase();
    const id = url.searchParams.get("id");
    if (ticketsFixture && templateId === TICKETS.template && !id) {
      if (ticketsMode === "unavailable") {
        return respond(response, 503, { message: "Fictional outage" });
      }
      if (ticketsMode === "emptyWithMore") {
        const page = Number(url.searchParams.get("next")?.slice(3) ?? 0);
        return respond(response, 200, { objects: [], next: `fx-${page + 1}` });
      }
    }
    if (integrated(id, templateId)) {
      if (!id) return forwardProgramme(request, response, url);
      // One object with its template's actions. The Studio fake Dual has no
      // template action list; this local fake reports the standard update.
      const upstream = await fetch(`${programmeDualUrl}/objects/${id}`);
      if (!upstream.ok) return respond(response, 200, { objects: [] });
      const object = await upstream.json();
      return respond(response, 200, {
        objects: [object],
        actions: [{ template_id: object.template_id, actions: ["update"] }],
      });
    }
    const list = [...objects.values()].filter(
      (object) =>
        (!templateId || object.template_id === templateId) &&
        (!owner || object.owner.toLowerCase() === owner) &&
        (!id || object.id === id),
    );
    if (!list.length && id) return undefined;
    return respond(response, 200, {
      objects: list,
      actions: [...new Set(list.map((object) => object.template_id))].map(
        (template) => ({
          template_id: template,
          actions: ["update", "transfer"],
        }),
      ),
    });
  }

  if (method === "GET" && path === "/ebus/action-logs" && authorized(request)) {
    const objectId = url.searchParams.get("object_id");
    if (integrated(objectId)) return forwardProgramme(request, response, url);
    return respond(response, 200, {
      action_logs: actionLogs.filter(
        (log) =>
          !objectId || log.affected_objects.some((o) => o.id === objectId),
      ),
    });
  }

  // The wallet executor's prepare (admission fixture only): the current
  // action number; it reserves and changes nothing.
  if (
    admissionFixture &&
    method === "POST" &&
    path === "/ebus/prepare" &&
    authorized(request)
  ) {
    return respond(response, 200, { nonce: 1, challenge: "ZmljdGlvbmFs" });
  }
  if (method === "POST" && path === "/ebus/execute" && authorized(request)) {
    const body = await readBody(request);
    const update = body?.action?.update;
    const transfer = body?.action?.transfer;
    // The signer is the session's own account (never the issuer).
    const signer =
      bearerAccount(request) === SECOND_ACCOUNT.walletId
        ? SECOND_ACCOUNT.walletAddress
        : PROGRAMME.walletAddress;
    if (transfer) {
      // G8: the holder's own Dual transfer of their unit to the recipient.
      const moving = objects.get(transfer.id);
      if (
        !moving ||
        moving.owner.toLowerCase() !== signer.toLowerCase() ||
        !/^0x[0-9a-fA-F]{40}$/.test(String(transfer.to))
      ) {
        return respond(response, 403, { message: "Not the holder" });
      }
      moving.owner = transfer.to;
      moving.when_modified = new Date().toISOString();
      const id = `action-${randomBytes(6).toString("hex")}`;
      actionLogs.unshift(
        actionLog(id, "transfer", moving.id, signer, "transfer"),
      );
      if (loseExecuteResponses > 0) {
        loseExecuteResponses -= 1;
        request.socket.destroy();
        return true;
      }
      return respond(response, 200, { action_id: id, steps: [] });
    }
    if (update && integrated(update.id)) {
      // The holder's own settle executes on the Studio fake Dual as the
      // session holder; it never carries issuer authority.
      return forwardProgramme(request, response, url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-fake-wallet": PROGRAMME.walletAddress,
        },
        body: JSON.stringify({ action: body.action }),
      });
    }
    const object = update && objects.get(update.id);
    if (!object || object.owner.toLowerCase() !== signer.toLowerCase()) {
      return respond(response, 403, { message: "Not the holder" });
    }
    // The holder signs a standard update of their own unit's custom data.
    object.custom = mergeCustom(object.custom, update.data?.custom ?? {});
    object.when_modified = new Date().toISOString();
    const id = `action-${randomBytes(6).toString("hex")}`;
    actionLogs.unshift({
      ...actionLog(id, "update", object.id, signer),
      // The executed custom update, so a reconcile can match it to a proposal.
      executed: { custom: update.data?.custom ?? {} },
    });
    if (loseExecuteResponses > 0) {
      // The action ran; its answer never reaches the wallet.
      loseExecuteResponses -= 1;
      request.socket.destroy();
      return true;
    }
    return respond(response, 200, { action_id: id, steps: [] });
  }
  return undefined;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && request.url === "/health") {
    return respond(response, 200, { ok: true });
  }

  if (
    request.method === "GET" &&
    request.url === `/public/objects/${publicObjectId}`
  ) {
    return respond(response, 200, publicObject);
  }

  if (request.method === "GET" && url.pathname === "/public/objects") {
    const objectId = url.searchParams.get("id");
    const variant = url.searchParams.get("display_variant") ?? "card";
    const found = objectId === publicObjectId;
    return respond(response, 200, {
      items: found ? [{ object: publicObject, display: display(variant) }] : [],
      objects: found ? [publicObject] : [],
    });
  }

  if (
    request.method === "GET" &&
    url.pathname.startsWith(`/public/objects/${publicObjectId}/display/`)
  ) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      ETag: '"face-e2e"',
    });
    response.end(
      "<!doctype html><html><body><strong>Rendered face: Sample Membership</strong></body></html>",
    );
    return;
  }

  if (request.method === "POST" && request.url === "/auth/password") {
    const body = await readBody(request);
    if (!body) return respond(response, 400, { message: "Invalid JSON" });
    if (body.organization_id !== expectedOrganizationId) {
      return respond(response, 422, {
        message: `Unexpected organization ID: ${body.organization_id}`,
      });
    }
    return respond(response, 200, {});
  }

  const handled = await handleProgramme(request, response, url);
  if (handled !== undefined || response.writableEnded) return;
  return respond(response, 404, { message: "Not found" });
});

server.listen(port, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close());
}

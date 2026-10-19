// LOCAL FICTIONAL FAKE of the provider for the Loyalty fixture, hosted by the
// fake API (MOCK_LOYALTY=1): the issuer-owned canonical membership and the
// member's opening pass as Dual objects, their action logs and state history,
// and the public views of all three. Writes come only through the test hook
// the fake runtime uses (the issuer's own actions). Not Dual.
import { createHash } from "node:crypto";

const hex = (value) => createHash("sha256").update(value).digest("hex");

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

/** The canonical template's published fields (Studio's 9 + 6 correlation). */
const CANONICAL_PUBLIC = [
  "recordId",
  "title",
  "memberReference",
  "programmeId",
  "state",
  "tierStatus",
  "eligibilitySummary",
  "benefitReference",
  "redemptionStatus",
  "activation_hash",
  "recipient_mint_projection",
  "product_type",
  "app_namespace",
  "operation_id",
  "idempotency_key",
];

export function loyaltyWorld({ organization, canonicalTemplate }) {
  let objects;
  let logs;
  let changes;
  let counter;
  function reset() {
    objects = new Map();
    logs = [];
    changes = [];
    counter = 0;
  }
  reset();

  function act({ object_id, name, account, written, init }) {
    counter += 1;
    const id = String(counter).padStart(4, "0");
    const actionId = `act-loyalty-${id}`;
    const stateChangeId = `sc-loyalty-${id}`;
    const before = objects.get(object_id);
    const now = new Date().toISOString();
    const object = before
      ? { ...before, custom: written, nonce: before.nonce + 1 }
      : {
          id: object_id,
          org_id: organization,
          template_id: init.template_id,
          owner: init.owner,
          nonce: 1,
          custom: written,
          metadata: { name: init.name ?? "Fictional object" },
          when_created: now,
        };
    object.content_hash = `0x${hex(canonicalJson({ written, n: object.nonce }))}`;
    object.state_hash = `0x${hex(canonicalJson({ o: object.owner, n: object.nonce }))}`;
    object.integrity_hash = `0x${hex(`${object.id}|${object.nonce}`)}`;
    object.prev_integrity_hash =
      before?.integrity_hash ?? object.integrity_hash;
    object.when_modified = now;
    objects.set(object_id, object);
    logs.unshift({
      id: actionId,
      name,
      account,
      controller: account,
      hash: `0x${hex(actionId)}`,
      message_hash: `0x${hex(`m${actionId}`)}`,
      params: init?.to
        ? { to: init.to, template_id: object.template_id, num: 1 }
        : { id: object_id },
      affected_objects: [
        {
          id: object_id,
          template_id: object.template_id,
          prev_state_hash: before?.state_hash ?? "",
          next_state_hash: object.state_hash,
          prev_integrity_hash: object.prev_integrity_hash,
          integrity_hash: object.integrity_hash,
          state_change_id: stateChangeId,
          change_type: before ? "update" : "create",
        },
      ],
      status: "completed",
      nonce: counter,
      when_created: now,
      when_modified: now,
    });
    changes.push({
      id: stateChangeId,
      wallet_id: "6e1e1e1e1e1e1e1e1e1e1e1e",
      object_id,
      action_id: actionId,
      action_name: name,
      change_type: before ? "update" : "create",
      prev_state_hash: before?.state_hash ?? "",
      next_state_hash: object.state_hash,
      prev_integrity_hash: object.prev_integrity_hash,
      next_integrity_hash: object.integrity_hash,
      prev_nonce: before?.nonce ?? 0,
      next_nonce: object.nonce,
      prev_content_hash: before?.content_hash ?? "",
      next_content_hash: object.content_hash,
      prev_owner: before?.owner ?? "0x0000000000000000000000000000000000000000",
      current_owner: object.owner,
      merkle_proof: [],
      batch_id: "batch-fictional",
      when_created: now,
    });
    return {
      action_id: actionId,
      action_name: name,
      object_id,
      account,
      next_nonce: object.nonce,
      readback_content_hash: object.content_hash,
      written_custom: written,
      written_custom_hash: `sha256:${hex(canonicalJson(written))}`,
    };
  }

  function publicView(object) {
    const fields =
      object.template_id === canonicalTemplate
        ? CANONICAL_PUBLIC
        : Object.keys(object.custom);
    return {
      ...object,
      custom: Object.fromEntries(
        fields
          .filter((key) => key in object.custom)
          .map((key) => [key, object.custom[key]]),
      ),
      version: 2,
    };
  }

  /** Handles one request if it is the world's; else returns false. */
  async function handle(request, response, url, respond, readBody) {
    const { pathname } = url;
    if (request.method === "POST" && pathname === "/__test__/loyalty/act") {
      return (respond(response, 200, act(await readBody(request))), true);
    }
    if (
      request.method === "GET" &&
      pathname.startsWith("/__test__/loyalty/objects/")
    ) {
      const object = objects.get(
        pathname.slice("/__test__/loyalty/objects/".length),
      );
      return object
        ? (respond(response, 200, object), true)
        : (respond(response, 404, {}), true);
    }
    if (request.method === "GET" && pathname === "/public/action-logs") {
      const id = url.searchParams.get("id");
      const found = logs.filter((log) => !id || log.id === id);
      return (respond(response, 200, { action_logs: found.slice(0, 1) }), true);
    }
    const match = /^\/public\/objects\/([0-9a-f]{24})(\/state-changes)?$/.exec(
      pathname,
    );
    if (request.method === "GET" && match && objects.has(match[1])) {
      if (!match[2]) {
        return (
          respond(response, 200, publicView(objects.get(match[1]))),
          true
        );
      }
      const id = url.searchParams.get("id");
      const own = changes.filter((change) => change.object_id === match[1]);
      const picked = id
        ? own.filter((change) => change.id === id)
        : url.searchParams.get("order") === "asc"
          ? own.slice(0, 1)
          : own.slice(-1);
      return (respond(response, 200, { state_changes: picked }), true);
    }
    return false;
  }

  return { reset, act, handle, objects: () => [...objects.values()] };
}

# ticket-admission-v1: holder-confirmed admission from the branded wallet (P4.3)

**Status: PROPOSED.** A new source contract between the shared Tickets service
(Studio's product-face runtime) and the wallet. Nothing here is implemented by
Studio, released, deployed or accepted live. Until the matching released
Tickets service supports it, the wallet treats entry as unavailable.

It replaces nothing: the generated-app holder login (`ticket_holder` role
session) and its runtime-held holder bearer
(`withGeneratedTicketHolderWriteAuthority`) are NOT used. The holder signs
their own Dual update in the wallet, with the wallet's existing native
execution (contracts r17/r18) and one-time operation-bound face assertions.

## 1. What the existing engine does (Studio `ff977a49c07a58e884d4810b6b3112e2a1661e4c`)

Read-only source facts this contract is derived from:

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Source                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `admit` is the domain transition `Valid` → `Admitted` (terminal), roles `venue_gate_verifier`, `event_operator`, gates `admission_window`, `event_identity_match`, `ticket_not_blocked`, required `evidenceRef`, `eventRef`.                                                                                                                                                                                                                                                                             | `src/domain-packs.mjs:339`                                                           |
| A gate `admit` only records `ticketAdmissionRequest` (`tig-ticket-admission-request-v1`: `id` `tad-<32 hex>`, `status: awaiting_holder`, `objectId`, `owner`, `contentHash`, `eventRef`, `requestHash`, `eventId`, `gateActor`, 5-minute `expiresAt`); zero Dual writes.                                                                                                                                                                                                                                 | `api/purpose-runtime.mjs:1225-1301`                                                  |
| `confirm_admission` today requires a `ticket_holder` signed role session and executes with the holder's Dual bearer held by the generated app. **This contract does not use it.**                                                                                                                                                                                                                                                                                                                        | `api/purpose-runtime.mjs:1308-1404`, `src/generated-app-wallet-access.mjs:1010-1075` |
| The admit write is `append_proof_event` on the bound object (`dualWriteInput`), carrying `ticketFaceProperties` (the ticket's ten face fields with `state` and `admissionStatus` = the record's new state) and `ticketLifecycleProjectionRequired: true`.                                                                                                                                                                                                                                                | `api/purpose-runtime.mjs:2447-2599`                                                  |
| For a ticket on the closed ticket template the written custom map is rebuilt from a FRESH authenticated pre-read: `{...retained, state, admissionStatus, operation_id, idempotency_key}` — exactly four keys change. The pre-read must have exactly the 16 schema keys, the eight identity fields (`recordId`, `title`, `eventRef`, `venueRef`, `accessClass`, `seatRef`, `admissionWindowStartsAt`, `admissionWindowEndsAt`) must equal the projection, and the write signer must be the current owner. | `src/dual-activation.mjs:48-53, 331-347, 4985-5015, 2815-2824`                       |
| The 16 schema keys: `accessClass`, `activation_hash`, `admissionStatus`, `admissionWindowEndsAt`, `admissionWindowStartsAt`, `app_namespace`, `eventRef`, `idempotency_key`, `operation_id`, `product_type`, `recipient_mint_projection`, `recordId`, `seatRef`, `state`, `title`, `venueRef`.                                                                                                                                                                                                           | `src/dual-activation.mjs:48-53`                                                      |
| The closed template admits no extra keys, so the write's binding to its intent is carried by `operation_id` = `op_` + first 40 hex of, and `idempotency_key` = `tig:dual-operation:` + all 64 hex of, `sha256(stableJson({appNamespace, orgId, templateId, actionType, clientActionId, expectedHash}))`; verification recomputes them (`ticketActionProofMatches`, carrier `operation_id_and_idempotency_key`).                                                                                          | `src/dual-activation.mjs:308-323, 349-353, 3436-3438`                                |
| The wire write is Dual `executeAction` `{action: {update: {id: <objectId>, data: {custom: <map>}}}}` (MCP), or REST `{action: {update: {id, custom}}}` / `{update: {id, data: {custom}}}`.                                                                                                                                                                                                                                                                                                               | `src/dual-activation.mjs:1614-1740`                                                  |
| Issuance identity: `activation_hash` (64 hex) is written at issue and preserved by every later ticket update; `operation_id`/`idempotency_key` are replaced by each lifecycle write and are NOT the issue identity after admission.                                                                                                                                                                                                                                                                      | `src/dual-activation.mjs:780, 804-827, 4998-5010`                                    |
| The record's pass code `DT1.<recordId>.<20 hex>` is `sha256(appInstanceId                                                                                                                                                                                                                                                                                                                                                                                                                                | recordId                                                                             | objectId | holderWallet)`truncated, released only once`ticketRecordCustody`holds (issued, exactly read back, nothing pending, holder recorded). Today only to a`ticket_holder` role session. | `src/ticket-record-runtime.mjs:37-85` |
| The shared product-face runtime (propose/reserve/verify/status, public action-log signer readback) is bound to `product-passport` only.                                                                                                                                                                                                                                                                                                                                                                  | `src/product-face-runtime.mjs:75, 438, 483-529, 1884-2306`                           |

## 2. Scope

- One programme face whose registry binding carries `tickets` rules AND the
  new optional `tickets.admission` block (§4). Absent: the wallet stays
  exactly P4.2 (read-only Tickets; entry unavailable).
- Only a ticket on the closed ticket template: a fresh object whose custom map
  has exactly the 16 keys of §1, owned by the signed-in holder, issued by the
  host's organisation, on a programme template. Any other shape is
  `admission_unsupported`; nothing is proposed or signed.
- Staff admission (gate scan and request) stays in Studio's event-scoped staff
  access. The wallet never creates a gate request.

## 3. Transport (existing, unchanged)

Every operation is one server-to-server call from the wallet BFF:

```
POST <binding.origin>/api/product-face/v1/operations
Content-Type: application/json
x-tig-product-face-application: <binding.applicationId>

{ "operation": "<name>", "operationId": "<wallet operation id>",
  "target": { "object_id": "<24 hex>" }, "input": { ... },
  "assertion": "<compact JWS>" }
```

- `assertion`: the existing one-time EdDSA face assertion
  (`dual-face-assertion+jwt`, 60 s, `jti`), claims `iss` (exact wallet
  origin), `aud` (`<applicationId>@<origin>`), `app_id`, `app_version`,
  `artifact`, `publisher`, `programme`, `origin`, `sub` (wallet id), `holder`
  (lowercase 0x address of the server-read session), `operation`, `op_id`,
  `target`, `request_hash`, `sid_hash`. `request_hash` =
  `sha256:` + hex sha256 of canonical JSON `{operation, operationId, target,
input}` (`runtimeRequestHash`).
- The runtime MUST refuse any call that carries an `Origin` header (server
  only), any assertion it did not verify with the wallet's published key, any
  `jti` it has seen, and any call whose body does not hash to `request_hash`.
- Bounded response (64 KiB), 8 s timeout, no redirects, no cookies. No new
  key, endpoint, discovery mechanism or credential channel.

The holder is ALWAYS the assertion's `holder`; no input field names a holder,
wallet, organisation, template, event or endpoint, and the runtime ignores
none silently: unknown input keys are `face_request_invalid` (400).

## 4. Registry binding: `tickets.admission` (new, optional)

```json
"tickets": {
  "fields": {
    "event": "title", "startsAt": "admissionWindowStartsAt", "venue": "venueRef",
    "entryClass": "accessClass", "entryGuidance": null,
    "issueOperation": "activation_hash", "state": "state"
  },
  "states": { "pending": [], "issued": ["Valid"], "ended": ["Cancelled", "Expired"] },
  "admission": {
    "contract": "ticket-admission-v1",
    "action": "update",
    "inputPath": "data.custom",
    "leaves": {
      "state": { "enum": ["Admitted"] },
      "admissionStatus": { "enum": ["Admitted"] },
      "operation_id": { "runtimeIssued": "^op_[0-9a-f]{40}$" },
      "idempotency_key": { "runtimeIssued": "^tig:dual-operation:[0-9a-f]{64}$" }
    },
    "customKeys": ["accessClass", "activation_hash", "admissionStatus", "admissionWindowEndsAt",
      "admissionWindowStartsAt", "app_namespace", "eventRef", "idempotency_key", "operation_id",
      "product_type", "recipient_mint_projection", "recordId", "seatRef", "state", "title", "venueRef"],
    "fromStates": ["Valid"],
    "targetStates": ["Admitted"],
    "preserveUnlisted": true
  }
}
```

- Exactly these keys; `contract` exactly `ticket-admission-v1`; `action`
  exactly `update`; `inputPath` exactly `data.custom`; the four leaves exactly
  as above (no other governed leaf); `customKeys` exactly the 16 keys;
  `fromStates` exactly `["Valid"]`, `targetStates` exactly `["Admitted"]`;
  `preserveUnlisted` exactly `true`. Anything else makes the binding invalid
  (the wallet's registry fails closed, as for every binding error).
- `issueOperation` for this template is `activation_hash`: it is the only
  issuance identity that survives admission.
- `Admitted` is in none of the P4.2 state lists: current Dual state alone never
  reads as admitted (§8).
- Absent `admission`: P4.2 bytes and behaviour, unchanged.

## 5. Operations (all new on the runtime)

`<op>` is the wallet operation id (`^[A-Za-z0-9_-]{16,80}$`, the existing face
operation id). Refusals are `{ ok: false, status, reason }` with plain
lowercase codes; every refusal names zero writes.

### 5.1 `ticket.pass.read`

- `operationId`: a fresh read id; `input`: `{}`.
- 200 `{ ok: true, status: "ticket_pass_ready", object_id, pass: { schema_version: "tig-ticket-pass-code-v1", code: "DT1.<recordId>.<20 hex>" } }`
  only when the record bound to `object_id` satisfies `ticketRecordCustody`
  with `custody.objectId === object_id` and `custody.holderWalletAddress ===
holder`, and the code equals `ticketPassCode({appInstanceId, recordId,
...custody})`.
- Otherwise 404 `ticket_pass_unavailable` (one answer for every refusal).

### 5.2 `admission.pending.read`

- `operationId`: a fresh read id; `input`: `{}`.
- 200, exactly one of:
  - `{ ok: true, status: "none", object_id }`
  - `{ ok: true, status: "awaiting_holder", object_id, request: { request_id, event_ref, created_at, expires_at } }`
  - `{ ok: true, status: "expired", object_id, request: { request_id, event_ref, created_at, expires_at } }`
  - `{ ok: true, status: "admitted", object_id, admission: { request_id, action_id, admitted_at, receipt_id } }`
    (only after §5.5's verification committed it).
- Only for the holder: the record's `ticketHolderWalletAddress`,
  `request.owner` and a fresh Dual owner all equal `holder`; the record's
  object is `object_id`. Otherwise 404 `admission_not_found`.

### 5.3 `admission.propose`

- `operationId`: the wallet's admission operation id `<op>` (begin);
  `input`: `{ request_id }`.
- Re-checks everything `confirmTicketHolderAdmission` checks today
  (`api/purpose-runtime.mjs:1323-1352`): request `awaiting_holder`,
  unexpired, bound instance/release/template, gate actor role and authority,
  `eventRef`, `owner === holder`, nothing pending in the outbox, payload hash,
  and a fresh Dual eligibility binding to the same object and content hash.
- Builds the write exactly as `executePurposeAction` would for this `admit`
  (preview → `dualWriteInput` → `dualActionCustom` → the closed-template
  rebuild over a fresh authenticated pre-read), WITHOUT dispatching, and
  persists its preimage (`clientActionId`, `expectedHash`) with the request.
- 200 `{ ok: true, status: "proposed", proposal: { proposal_id, request_id, object_id, action: "update", input: { data: { custom: <the 16-key map> } }, proposal_hash, expires_at } }`
  where `proposal_hash` = `sha256:` + hex sha256 of canonical JSON
  `{object_id, action, input}` and `expires_at <= request.expires_at`.
- One open proposal per request; a repeat returns the same proposal
  (`idempotent: true`).
- Refusals: 409 `admission_request_expired`, `admission_request_mismatch`,
  `admission_binding_mismatch`, `admission_reconciliation_required`,
  `admission_unsupported` (not the closed template); 404
  `admission_not_found`.

### 5.4 `admission.reserve`

- `operationId`: `<op>`; `input`: `{ proposal_id, request_id }`.
- One atomic claim per request (compare-and-set): 200 `{ ok: true, status:
"granted", dispatch: "won", reservation: { admission_operation_id: <op>,
object_id, proposal_id, request_id } }` exactly once. A replay of the same
  call answers the same body with `idempotent: true` (NOT a win for the
  wallet); any other claim 409 `already_claimed` / `already_reserved`; an
  expired request or proposal 409 `admission_request_expired`.
- After `won`, no new proposal or reservation exists for that request; only
  §5.5/§5.6 follow.

### 5.5 `admission.verify`

- `operationId`: `<op>`; `input`: `{ action_id, proposal_id, request_id }`.
- Requires the reservation of §5.4 for exactly this `<op>`, proposal and
  request. Reads Dual: the object's newest `update` with `action_id`, its
  public action log (`account === request.owner`, `name === "update"`,
  object), and a fresh authenticated object whose custom map is
  deep-equal to the proposal's map (all 16 keys, including `operation_id`
  and `idempotency_key`), with `operation_id`/`idempotency_key` equal to
  `dualDispatchIdentifiers` over the persisted preimage.
- Then commits the record exactly as today's confirmed admit does (event,
  `state: Admitted`, `ticketAdmissionRequest.status: confirmed`, receipt,
  outbox `verified`) and reads it back.
- 200 `{ ok: true, status: "admitted", admission: { request_id, object_id, action_id, admitted_at, receipt_id, readback: { state: "Admitted", admission_status: "Admitted", operation_id, idempotency_key } } }`.
- 202 `{ ok: false, status: "outcome_unknown" }` when the action cannot be
  read yet; 409 `admission_action_mismatch` when it is not this proposal's
  (another signer, object, map or identifiers). Never a write to Dual.

### 5.6 `admission.status`

- `operationId`: `<op>`; `input`: `{ proposal_id, request_id }`.
- Read-only reconcile after a lost reserve, execute or verify answer: finds
  the holder's `update` itself from Dual history and action logs since the
  reservation (as `holderSettleAction` does for settle), then answers as
  §5.5. Never executes, never releases, never re-reserves.

## 6. Wallet obligations (this repository)

- Only for the pinned binding, journey, face, object, holder and session; the
  Tickets journey of the host (no extra host flag); BFF routes under
  `/api/faces/<slug>/tickets/<objectId>/admission/*` and `.../pass`.
- First fetch is the holder's own "Check for entry request"; no automatic
  polling.
- Native confirmation from server-read facts: event, venue, admission window,
  gate request id and expiry, the holder, and the effect (state and admission
  status become `Admitted`; nothing else changes).
- Before reserve: the proposal must pass `matchCompleteTemplate` against the
  wallet's own fresh read (complete map, governed leaves only, the 16
  `customKeys` exactly, `fromStates`), the hash, the object, the request and
  expiry. Cancel there is zero writes.
- Journal kind `admission` (sealed to session, launch, face and programme),
  reserve server to server, execute through `/api/backend` with the r18 face
  headers only after this request's own `won`, then verify.
- Lost answers after `won`: `outcome_unknown`, read-only `admission.status`
  only; never sign, resend, cancel, reserve again or release.
- "Entry confirmed" only from §5.5/§5.6 `admitted` plus the wallet's own
  fresh read showing the proposal's exact map.

## 7. Recovery

| Case               | Runtime                                                   | Wallet                                                                     |
| ------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| Wrong holder       | 404 on every operation; verify requires signer = owner.   | Holder from the session only; current owner re-read before begin and send. |
| Wrong event        | `event_identity_match`, request `eventRef` = record's.    | Proposal map must keep `eventRef` (unchanged leaf).                        |
| Window / expiry    | Gate `admission_window`; `expires_at`; reserve refuses.   | No begin or send after `expires_at`.                                       |
| Repeat             | Duplicate receipt, no write; one reservation per request. | Never re-reserve or re-execute; a second confirm reads the receipt.        |
| Lost reply         | `admission.status` from Dual only.                        | `outcome_unknown`, keep the original journal entry and operation.          |
| Holder self-update | Not admission: no request-bound identifiers.              | Dual state alone is never "admitted".                                      |

## 8. Never

- Dual's `state: Admitted` on its own is never admission, in the runtime or
  the wallet; only §5.5's request-bound verification is.
- No holder credential leaves the wallet; no assertion, signature, proposal
  map or pass code is logged or stored beyond the existing sealed journal.

## 9. Open items Studio must confirm before acceptance

1. A holder-issued ticket's LIVE object has exactly the 16 closed-template
   keys (the source handles both shapes; this contract supports only that
   one).
2. The runtime will build the proposal with the same code path as a
   dispatched admit (no second, hand-written map).
3. The holder's own Dual REST `/ebus/execute` `{action: {update: {id, data:
{custom}}}}` produces the same object state as the runtime's MCP
   `executeAction` for the same map.

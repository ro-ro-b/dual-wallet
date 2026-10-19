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
| `activation_hash` (64 hex) is the immutable issuance CONTENT identity: written at issue and preserved by every later ticket update. It is not an operation id. `operation_id`/`idempotency_key` hold the birth operation only until the first lifecycle write replaces them.                                                                                                                                                                                                                             | `src/dual-activation.mjs:780, 804-827, 4998-5010`                                    |
| The original birth operation is recorded on the record's `issue_ticket` outbox entry (`operationId`, `idempotencyKey`, `clientActionId`, `originalPreparation`; "never trimmed"), and the birth Dual action on the issue event's `dualProof` (`actionId`, `providerActions[0]` of type `mint`, `expectedHash` = `activation_hash`). At mint, Dual's object carried that `operation_id` (the mint reconciliation matches `custom.operation_id`).                                                          | `api/purpose-runtime.mjs:2411-2419, 2632-2700`; `src/dual-activation.mjs:3505-3525`  |
| The existing Dual history read (`normalizedObjectHistory`) yields per change only `type`, owner, `action_id`, nonce and `next_content_hash`; past custom maps are not read.                                                                                                                                                                                                                                                                                                                              | `src/generated-app-wallet-access.mjs:58-67, 88-93`                                   |
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

## 3. Transport (existing; optional workload authentication)

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
- Optional workload authentication for a runtime behind Vercel Deployment
  Protection: when `TIG_RUNTIME_OIDC_ORIGINS` lists the binding origin, the
  call also carries the wallet deployment's platform OIDC token in
  `x-vercel-trusted-oidc-idp-token` (external-face-integration.md, "Runtime
  workload authentication"). It identifies the calling deployment only and
  never replaces the assertion.

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
- `issueOperation` for this template names `activation_hash` ONLY as the
  P4.2 projection's "issuance recorded" gate: it is the immutable issuance
  content identity, NOT the original issue operation, and with `admission`
  present the wallet never displays it as an operation or reference. The
  original birth operation and action are shown only from §5.1's runtime
  issuance proof; nothing reconstructs them from the current `operation_id`.
- `Admitted` is in none of the P4.2 state lists: current Dual state alone never
  reads as admitted (§8).
- Absent `admission`: P4.2 bytes and behaviour, unchanged.

## 5. Operations (all new on the runtime)

`<op>` is the wallet operation id (`^[a-z0-9-]{8,64}$`, the existing face
operation id). Refusals are `{ ok: false, status, reason }` with plain
lowercase codes.

### 5.0 Write accounting

- None of these operations writes to Dual itself; their accounting fields
  (`runtime_dual_writes: 0`) describe only that call.
- No response may describe the HOLDER's admission attempt as zero, not sent
  or failed once `admission.reserve` has answered `won` for its request: the
  holder may have dispatched. Every response for such a request carries
  `holder_dispatch`: `"reserved"` (won, outcome not proven), `"verified"`
  (§5.5), or, for a request never reserved, `"none"`.
- A refusal after `won` (401/403, an unavailable or lost verification, a
  timeout) is an answer about that call only: the attempt stays
  `outcome_unknown` with its original reservation and journal, never
  `not_submitted`, and only §5.6 may read it further.

### 5.1 `ticket.pass.read`

- `operationId`: a fresh read id; `input`: `{}`.
- 200 `{ ok: true, status: "ticket_pass_ready", object_id, pass: { schema_version: "tig-ticket-pass-code-v1", code: "DT1.<recordId>.<20 hex>" }, issuance: <proof> }`
  only when the record bound to `object_id` satisfies `ticketRecordCustody`
  with `custody.objectId === object_id` and `custody.holderWalletAddress ===
holder`, and the code equals `ticketPassCode({appInstanceId, recordId,
...custody})`.
- `issuance` (`ticket-issuance-proof-v1`), read and checked by the runtime on
  every call, never from the catalog alone and never from the current
  `operation_id`:

  ```json
  {
    "schema_version": "ticket-issuance-proof-v1",
    "record_id": "<record id>",
    "object_id": "<24 hex>",
    "activation_hash": "<64 hex>",
    "birth_operation_id": "op_<40 hex>",
    "birth_idempotency_key": "tig:dual-operation:<64 hex>",
    "birth_action_id": "<Dual action id>",
    "evidence": {
      "birth_action": "verified",
      "activation_hash": "verified",
      "operation_commitment": "verified",
      "operation_readback": "current | superseded"
    }
  }
  ```

  - `birth_operation_id`/`birth_idempotency_key`: the record's `issue_ticket`
    outbox entry, recomputed by `dualDispatchIdentifiers({actionId:
clientActionId}, config, "mint_asset", activation_hash)` and equal to
    it (`operation_commitment: verified`).
  - `activation_hash`: the fresh Dual object's `custom.activation_hash`,
    equal to the issue event's `dualProof.expectedHash`
    (`activation_hash: verified`).
  - `birth_action_id`: the issue event's `dualProof.providerActions[0]`
    (type `mint`); Dual's object history has a `mint` change with that
    `action_id`, and its public action log names this object
    (`birth_action: verified`).
  - `operation_readback`: `current` when the fresh object's `operation_id`
    is still `birth_operation_id` (no later update); `superseded` once a
    later update replaced it (§10.1).
  - When any check does not hold, `issuance` is absent (the pass may still
    be served) and the wallet shows no original issue operation.

- Otherwise 404 `ticket_pass_unavailable` (one answer for every refusal).

### 5.2 `admission.pending.read`

- `operationId`: a fresh read id; `input`: `{}`.
- 200, exactly one of:
  - `{ ok: true, status: "none", object_id }`
  - `{ ok: true, status: "awaiting_holder", object_id, request: { request_id, event_ref, created_at, expires_at } }`
  - `{ ok: true, status: "expired", object_id, request: { request_id, event_ref, created_at, expires_at } }`
  - `{ ok: true, status: "admitted", object_id, admission: { request_id, action_id, admitted_at, receipt_id, readback: { state, admission_status, operation_id, idempotency_key } } }`
    only after §5.5's verification committed it AND, on THIS call, a fresh
    Dual read shows the committed admission map exactly (`state` and
    `admissionStatus` `Admitted`, `operation_id`/`idempotency_key` equal to
    the committed proposal's) and the action log of `action_id` names the
    request's owner as signer. A saved record state or an old receipt alone
    is never enough.
  - `{ ok: true, status: "admission_unverified", object_id, request: { request_id, event_ref, created_at, expires_at } }`
    when the record says admitted but this call's fresh Dual proof does not
    hold (a later update, drift, or an unreadable action log).
- A holder's own update that writes `Admitted` without this contract's
  request-bound identifiers is not admission: `none` (or the request's real
  status), never `admitted`.
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
  fresh read showing the proposal's exact map; on a fresh or reopened
  device, from §5.2 `admitted` plus the wallet's own fresh read matching its
  `readback` exactly. `admission_unverified`, a refusal, or an unreadable
  answer is never shown as entry.
- After `won`, no refusal, 401/403, unavailable verification or lost reply
  turns the attempt into "not sent": it stays `outcome_unknown` under its
  original operation.
- The original issue operation and action are shown only from §5.1's
  `issuance` with every `evidence` check `verified` (`operation_readback`
  shown as is); `activation_hash` only as the issuance content hash, under a
  technical disclosure.
- Every transition after `begin` (`confirm`, `cancel`, `record_action`,
  `status`) names its operation and is accepted only through the URL of the
  exact ticket that operation was begun for (same programme, same object):
  through another ticket's URL it is refused `unknown_operation` before any
  runtime, provider or executor work.
- The ticket's own status never contradicts entry. Only for a binding with
  `tickets.admission`, Dual's own state in `targetStates` (with the issue
  identity) reads "Entry recorded" (`admission_recorded`) on the ticket, the
  home and the list: not "not confirmed", and never entry by itself. The
  ticket header says "Entry confirmed" only after a verified `admitted` and
  a Dual read of the ticket made after it that agrees. A legacy binding keeps
  P4.2's status (`Admitted` stays "not confirmed").
- An outcome that may follow a write (`admitted`, `admission_unverified`,
  `outcome_unknown`) marks that ticket's detail and list reads stale, and an
  open pass is read again: no pass proof read before an entry (for example
  `operation_readback: current`) is shown after it.

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

- `ticket.pass.read`'s `issuance` proof is implemented as §5.1 states, and
  the issue event's `providerActions[0]` is the `mint` action (for an issue
  with a post-mint update, `dualProof.actionId` is the update's).

1. A holder-issued ticket's LIVE object has exactly the 16 closed-template
   keys (the source handles both shapes; this contract supports only that
   one).
2. The runtime will build the proposal with the same code path as a
   dispatched admit (no second, hand-written map).
3. The holder's own Dual REST `/ebus/execute` `{action: {update: {id, data:
{custom}}}}` produces the same object state as the runtime's MCP
   `executeAction` for the same map.

## 10. Contract limits (stated, not invented)

1. **Birth operation after a later update.** Dual's history as the existing
   adapter reads it carries no past custom map, so once a later update (the
   admission itself) replaces `operation_id`, the birth `operation_id` can no
   longer be read back from Dual. It is then established by the record's
   original preimage, recomputed against the Dual-verified immutable
   `activation_hash` (`operation_commitment: verified`), while the birth
   ACTION stays Dual-attested (`birth_action: verified`), with
   `operation_readback: superseded` stated. If acceptance requires a Dual
   re-read of the birth `operation_id` after admission, that needs a
   provider capability this source does not establish (a history read that
   returns past custom maps), and v1 cannot meet it.
2. The wallet stores no issuance proof: "identical before and after
   admission" is the runtime returning the same `birth_operation_id` and
   `birth_action_id` on each call, which the wallet checks and shows.

## 11. Wallet implementation status (source only)

The wallet half of this contract is implemented in source and proven only
against LOCAL FICTIONAL fakes of the shared Tickets service and Dual; nothing
here is live, and the matching runtime leg is Studio's to implement.

- Binding: optional `tickets.admission`, parsed exactly
  (`app/_domain/ticket-admission.ts` `parseAdmissionRules`); absent keeps
  P4.2 unchanged.
- BFF: `POST /api/faces/<slug>/tickets/<objectId>/admission` with
  `transition` `check`, `pass`, `begin`, `confirm`, `cancel`,
  `record_action`, `status` (`api/product-face-admission.ts`). Runtime calls
  through `ticketRuntimeCall` (`api/face-runtime.ts`), host-only operations
  (`ticketHostOperations`), minted by the existing `mint`.
- Journal kind `admission` (`app/_domain/product-face-journal.ts`), bound
  to `admissionRequestId`, `proposalId`, `freshHash` and `inputHash`; a sent
  step is unresolved evidence a launch never drops (`api/face-journal.ts`).
- `/api/backend` forwards an admission step only for its own won reservation
  and only with exactly the confirmed custom map
  (`api/face-execution-binding.ts`); on a branded host it is the Tickets
  journey's (`api/host-journey-guard.ts`).
- Native page: `app/_components/products/ticket-admission.tsx` on the ticket
  detail when the binding carries `admission`; the ticket status
  `admission_recorded` (`app/_domain/tickets.ts`) and the verified header in
  `app/_components/products/tickets-view.tsx`; `useRefreshTicket`
  (`app/_hooks/use-tickets.ts`) re-reads exactly that ticket's detail and
  list.
- Tests: `api/product-face-admission.test.ts` (real handlers, journal and
  proxy, including an operation sent through another ticket's URL),
  `app/_domain/ticket-admission.test.ts`, `app/_domain/tickets.test.ts`,
  `app/_components/products/ticket-admission.test.tsx`,
  `app/_components/products/tickets-view.test.tsx`.
- Browser (FICTIONAL):
  `npx playwright test -c playwright.tickets-admission.config.ts`
  (`e2e/tickets-admission.spec.ts`; ports 3320, 4320 and 4330, set
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE` where needed) runs the real wallet against the local fake api-v3
  (`MOCK_TICKETS_ADMISSION=1`) and a LOCAL FAKE runtime
  (`e2e/tickets-home/fake-tickets-runtime.mjs`) that verifies each EdDSA
  assertion. It covers the phone keyboard journey with whole-page checks
  (header, pass before and after, home, list, reopen), a lost verification
  read back under the original operation, and Escape with zero writes. The
  fake is not Studio's runtime and proves nothing about it.

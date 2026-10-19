# Loyalty join and earn from the branded wallet: `loyalty-join-earn-v1`

**Status.** Final wire contract. The wallet half is implemented in source
(§9) and proven only against FICTIONAL local fakes; the matching runtime
leg is Studio's to build. Nothing here is live, and the §8 blockers stand. Every operation, binding key,
journal kind and route below is new to this contract. Everything else is
existing Studio source at `ff977a4` (cited), and provider behaviour is the
generated SDK's contract plus root's read-only observations, **live-unverified
for Loyalty**. Background:
[p4-loyalty-diagnosis.md](../development/p4-loyalty-diagnosis.md).

## 1. Scope and custody (existing, unchanged)

One member journey, with no event: read the programme → join with terms
consent → operator approval → issuer-owned canonical membership plus the
member's opening pass → activity submission → verifier acceptance → the
member sees that exact submission counted. Benefit, redemption, partner
confirmation and physical fulfilment are a later contract.

- **Canonical membership.** Issuer-owned. Every lifecycle write is signed by
  the Studio runtime's issuer account and passes the existing custody gate
  (`api/purpose-runtime.mjs:3349-3351`).
- **Opening pass.** `participant-opening-pass-v1`: minted once by the
  issuer account (its separate pass key) to the member's wallet, `mint`
  only (`src/participant-opening-pass-template.mjs`).
- **Member authority.** The wallet's existing one-time face assertion; the
  holder is the server-read session. The member signs nothing on Dual and
  never writes the canonical record. No holder executor, no `/api/backend`.
- **Staff.** programme_operator approves and creates; activity_verifier
  verifies (existing Studio role sessions).
- **Not in v1.** No points, balance, tier or eligibility is shown or
  inferred. No rejection is shown: Studio has no `reject_activity`, so an
  unverified submission stays "waiting for verification".

## 2. Transport (existing)

```
POST <binding.origin>/api/product-face/v1/operations
Content-Type: application/json
x-tig-product-face-application: <binding.applicationId>
[x-vercel-trusted-oidc-idp-token: <platform OIDC>]   (TIG_RUNTIME_OIDC_ORIGINS only)

{ "operation", "operationId", "target", "input", "assertion" }
```

- **Target.** `{model_id}` for programme, join and membership;
  `{model_id, object_id}` (the canonical membership) for submit and status.
- **Assertion.** The existing one-time EdDSA face assertion, with
  `request_hash` = `sha256:` + hex sha256 of canonical JSON
  `{operation, operationId, target, input}`. The runtime MUST refuse:
  - an `Origin` header;
  - an unverified, expired or replayed assertion;
  - a body that does not hash to `request_hash`;
  - any unknown input key (`face_request_invalid`).
- **Holder.** Always the assertion's `holder` and `sub` (wallet id). No
  input names a holder, member, wallet, organisation, template or object
  other than `target`.

## 3. Shared wire types

**Three distinct identities, never compared with each other.**

- `custom.recordId`: Studio's application record reference (for example
  `mbr-…`), assigned before the mint and written into every map
  (`api/purpose-runtime.mjs:2475`).
- `object_id`: the provider's minted object id, which does not exist before
  the mint; Studio keeps it apart from the record (`proof.objectId`,
  `src/studio-loyalty-programme.mjs:208, 241, 566`).
- `action_id`: one Dual action-log id.

Correlation is always like with like: a receipt's `written_custom.recordId`
against the fresh canonical `custom.recordId` (and its public projection),
and a receipt's `object_id` against the canonical `object_id`. A `recordId`
is never an object id, and no Dual field is added for either.

Canonical JSON: keys sorted at every level, no whitespace, strings escaped as
`JSON.stringify`, absent members omitted. `Hash` = `sha256:<64 lowercase
hex>`. `Addr` = lowercase `0x` + 40 hex. `Id24` = 24 lowercase hex.

```
Accounting      = { "dual_writes": 0 | 1 | "unknown", "reason": Code }
Code            = /^[a-z][a-z0-9_]{0,63}$/

CanonicalRead   = {   // a FRESH authenticated exact read made for this call
  "object_id": Id24, "template_id": Id24, "org_id": Id24, "owner": Addr,
  "nonce": int>=1, "state_hash": string, "content_hash": string,
  "custom": { ...the object's full custom map, as read... },
  "read": "authenticated_exact", "read_at": ISO-8601 }

ActionReceipt   = {   // one Dual action, from the runtime's retained write
  "action_id": string,          // the Dual action-log id
  "action_name": "mint" | "update",
  "semantic": "create_membership" | "submit_activity" | "verify_activity",
  "object_id": Id24,
  "account": Addr,              // signer, from the runtime's fresh action-log read
  "next_nonce": int>=1,         // the object's nonce after this action
  "readback_content_hash": string,  // content hash read back after the write
  "written_custom": { ...the object's FULL custom map as this action left it
                      at next_nonce (not a partial patch)... },
  "written_custom_hash": Hash } // over canonical JSON of written_custom
```

The runtime returns application truth only as labelled programme records
(`join`, `approval`). Every claim about Dual is a `CanonicalRead` made at
call time, or an `ActionReceipt` the wallet re-proves against the provider
(§5). A cached status is never a field here.

## 4. Operations (final schemas)

Every response carries `accounting`. Every join, approval and refusal answer
has `dual_writes: 0` and its reason; the wallet treats one without exact
accounting as unavailable.

### 4.1 `loyalty.programme.read` (read)

`input: {}`. 200:

```
{ "ok": true, "status": "programme_open" | "programme_closed",
  "programme": { "model_id", "programme_id", "revision_hash": Hash,
    "name", "headline", "member_promise",
    "terms_version", "consent_statement", "data_use",
    "consent_fingerprint": Hash,
    "activities": [{ "activity_type": /^[a-z0-9][a-z0-9-]{0,63}$/,
                     "label", "evidence_hint" }] },
  "accounting": { "dual_writes": 0, "reason": "programme_read" } }
```

Existing source: `loyaltyJoinProgramme`, `src/loyalty-record-runtime.mjs:571`.
Text fields are plain text, at most 500 characters each.

### 4.2 `loyalty.join.request` (programme write, zero Dual writes)

`input: { "consent": { "accepted": true, "terms_version", "fingerprint": Hash } }`.

This maps to the existing role request
(`src/generated-app-role-requests.mjs:402-462`). The subject is the
assertion's holder and wallet, not a generated-app session. The request is
idempotent by `operationId`.

| HTTP | `status`                                                                             | Body                                                                                                       |
| ---- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 200  | `join_requested` (`idempotent: true` on a replay)                                    | `join: {request_id, terms_version, consent_hash, requested_at}`, `accounting {0, "join_request_recorded"}` |
| 409  | `join_already_requested`, `membership_exists`, `consent_changed`, `programme_closed` | `accounting {0, <status>}`                                                                                 |
| 400  | `consent_required`                                                                   | `accounting {0, "consent_required"}`                                                                       |
| 404  | `programme_not_found`                                                                | `accounting {0, "programme_not_found"}`                                                                    |

`request_id` is `/^areq_[A-Za-z0-9_-]{20,40}$/`. Consent is a private
programme record (`consentRecord` is private, `src/domain-packs.mjs:240`),
never a Dual fact.

### 4.3 `loyalty.membership.read` (read)

`input: {}`. 200:

```
{ "ok": true, "status": "none" | "pending_approval" | "declined"
          | "pending_creation" | "pending_pass" | "active" | "held" | "ended",
  "join"?:      { "request_id", "terms_version", "consent_hash", "requested_at" },
  "approval"?:  { "status": "pending" | "approved" | "declined",
                  "decided_at"?: ISO, "accounting": { "dual_writes": 0, "reason": Code } },
  "canonical"?: CanonicalRead,
  "opening"?:   ActionReceipt,          // semantic create_membership, action_name mint
  "pass"?:      { "object_id": Id24, "template_id": Id24 },
  "accounting": { "dual_writes": 0, "reason": "membership_read" } }
```

| `status`                    | Required fields                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `none`                      | none                                                                                                      |
| `pending_approval`          | `join`, and `approval {status: "pending"}` with `dual_writes: 0`                                          |
| `declined`                  | `join`, and `approval {status: "declined"}` with `dual_writes: 0`                                         |
| `pending_creation`          | `join`, and `approval {status: "approved"}` with `dual_writes: 0`                                         |
| `pending_pass`              | `canonical` and `opening`                                                                                 |
| `active`, `held` or `ended` | `canonical`, `opening` and `pass`; `held` and `ended` are a canonical `state` of `Suspended` or `Expired` |

### 4.4 `loyalty.activity.submit` (one Dual write by the issuer)

`input: { "activity_type", "evidence_ref" }`. `evidence_ref` is plain text,
1–1000 characters, no leading or trailing whitespace. The runtime runs the
existing `submit_activity` as role member, with its duplicate-evidence check
(`src/loyalty-record-runtime.mjs:329-339`).

**Idempotent by `operationId`.** The runtime looks the operation id up
before every other check. For an operation it already holds (accepted,
applied or still in flight) it writes nothing and answers 409
`operation_already_received`; the wallet treats that as `outcome_unknown`
and reads `loyalty.activity.status`. Every other refusal below is only ever
about an operation the runtime does not hold, so it means this operation
wrote nothing and never will.

| HTTP | `status`                                                                                        | Body                                                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200  | `activity_submitted`                                                                            | `submission {evidence_hash, activity_type, submitted_at}`, `canonical`, `action` (submit_activity), `accounting {1, "activity_submitted"}`        |
| 409  | `loyalty_activity_evidence_duplicate`, `loyalty_activity_type_unknown`, `membership_not_active` | `accounting {0, <status>}`                                                                                                                        |
| 409  | `loyalty_activity_not_permitted`                                                                | `accounting {0, <status>}`: the state is not `Member` or `Activity verified` ([loyalty-benefit-redeem-v1](./loyalty-benefit-redeem-v1.md) §2 (3)) |
| 409  | `operation_already_received`                                                                    | `accounting {0, "operation_already_received"}`: not a refusal of the operation; the wallet keeps it unknown                                       |
| 202  | `outcome_unknown`                                                                               | `accounting {"unknown", "outcome_unknown"}`                                                                                                       |

`evidence_hash` = `sha256:` + hex sha256 of the exact `evidence_ref` (the
existing `loyaltyHash`). The wallet computes it itself.

### 4.5 `loyalty.activity.status` (read, the original operation only)

`operationId` is the original submit's id; `input: {}`.

| `status`                | Body                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `submitted`             | `submission`, `canonical`, `action` (submit_activity)                                                                              |
| `verified`              | `submission`, `canonical`, `action` (submit_activity), `verification` (an ActionReceipt with semantic verify_activity)             |
| `not_received`          | `accounting {0, "operation_not_received"}`: the runtime never accepted this operation and, its assertion having expired, never can |
| `outcome_unknown` (202) | `accounting {"unknown", "outcome_unknown"}`                                                                                        |

## 5. What the wallet proves before it says so

`expectedMember` = `sha256:` + hex sha256 of the session's Dual wallet id
(Studio's `memberReference` = sha256(memberId), with memberId the member's
wallet id in participant custody: `api/purpose-runtime.mjs:1114-1121`,
`src/participant-opening-pass.mjs:61`).

**Canonical read C.** All of the following must hold:

- `org_id` = the host's client;
- `template_id` = `binding.loyalty.canonicalTemplateId`;
- `owner` = `canonicalIssuerAccount`;
- `custom.programmeId` = `binding.loyalty.programmeId` and
  `custom.memberReference` = `expectedMember`;
- `custom.recordId` is a non-empty application record reference (not an
  object id) and `custom.state` is a lifecycle state;
- the wallet's own public read (`GET /public/objects/{id}`) shows the same
  owner, template, `nonce`, `state_hash` and `content_hash`, and every public
  custom key equals C's. A public subset alone proves nothing more.

**Action receipt R on C.** All of the following must hold:

1. `written_custom_hash` = sha256(canonical JSON of `written_custom`);
   `object_id` = C's; `account` = `canonicalIssuerAccount`; and
   `action_name` is `mint` for create_membership, `update` otherwise.
   Dual records verify as `update`: no public `verify_activity` name is
   assumed.
2. `written_custom` is the existing Studio write format:
   - `generic_semantic_purpose` = `membership-loyalty-rewards`;
   - `recordId` = C's `custom.recordId` (the immutable application record
     reference, compared only with itself; `object_id` is checked in (1)),
     `programmeId` as bound, `memberReference` = `expectedMember`;
   - `state`: `Member` for create, `Activity pending` for submit,
     `Activity verified` for verify;
   - for submit and verify, `lifecycle.action_id` starts with
     `membership-loyalty-rewards_<semantic>_`;
   - for submit, `proof_event.public_fields` contains exactly
     `activityEvidenceHash:<evidence hash>` (`src/trust-kernel.mjs:506`,
     `src/dual-activation.mjs:1401-1413`).
3. **Signer, from the provider, by the wallet.**
   `GET /public/action-logs?id=<action_id>&limit=1` returns exactly one log
   with that id and name, whose `account` (lowercased) is
   `canonicalIssuerAccount` and whose `affected_objects` contains C. A state
   change's `wallet_id` is a wallet id, never compared as an address.
4. **Provider tie.** The state change that log names
   (`affected_objects[].state_change_id`, read with
   `GET /public/objects/{id}/state-changes?id=…&limit=1`) has this
   `action_id`, `next_nonce` = R's, `next_content_hash` =
   `readback_content_hash`, and `current_owner` = the issuer. C's `nonce` is
   at least R's `next_nonce`.
5. **Current or historical.** If R's `next_nonce` = C's `nonce`, R is C's
   current state: `written_custom` must equal C's fresh `custom` exactly
   (canonical JSON, every key) and `readback_content_hash` must equal C's
   `content_hash`. A retained map with a recomputed hash proves nothing by
   itself; with genuine action, signer, state change, nonce and hash, a
   receipt whose map says `Activity pending` or `Activity verified` while C
   says `Member` at that nonce is refused. If R's `next_nonce` < C's
   `nonce`, R is historical: provider-tied by (3) and (4) only (action,
   signer, nonce, content hash), its retained map the runtime's record (the
   provider publishes no custom history). The opening receipt is usually
   historical, a submission is current when first proven, and a
   verification is current when counted.

**Active.** C and the opening receipt pass, and the holder's own session
reads exactly the runtime-named pass: `GET /objects?id=<pass object id>&owner=<holder>&template_id=<passTemplateId>`,
never an inventory page. The answer must be exactly that object id, owned
by the holder, from that template. Only an exact empty answer or a 404 means
the pass is not held yet (`pending_pass`); a 401 is an expired session; a
403, a 5xx, a network failure, or a malformed, ambiguous or mismatched answer
is `unconfirmed` and claims no absence. The pass's custom has:

- `schema` = `participant-opening-pass-v1`;
- `product_type` = `participant_opening_pass`;
- `canonical_object_id`, `canonical_template_id`, `canonical_issuer_account`
  and `organization_id` as bound;
- `opening_action_id` = the opening receipt's `action_id`;
- `openingState` = `Member`.

The pass's own `mint` (its first public state change, then the public action
log) must be by the issuer, to the holder, from `passTemplateId`. A canonical
membership without such a pass is `pending_pass`, not active.

**Submitted.** The submission's receipt passes (2) with the wallet's own
evidence hash, plus (1), (3), (4) and (5).

**Counted.** `verified`, with both receipts passing (1)–(5). The verification's
`next_nonce` must be exactly the submission's `next_nonce` + 1: the
very next change to the canonical object. Studio cannot run another
`submit_activity` from `Activity pending` (`src/domain-packs.mjs:228`), so
no later or unrelated verified action or state can stand in for this
submission. Dual's current `state` alone never counts.

Anything the wallet cannot prove is shown as "can't be confirmed right now",
or as the programme's record (join and approval, labelled as such). It is
never shown as progress.

## 6. Recovery

A submission is two wallet requests, so its record is in the browser before
anything can be sent:

1. **`prepare`** (activity type and evidence). The wallet re-proves the
   membership active (§5, fresh reads), allots the operation id and
   journals it in the launch's sealed cookie (kind `loyalty`, phase
   `confirmed`): operation id, canonical object id, activity type, evidence
   hash and the exact `request_hash`, never the evidence text. Its answer,
   with that Set-Cookie, names the operation id. Nothing is sent.
2. **`submit`** (that operation id, the same activity type and evidence).
   Only for this launch's own prepared entry, with exactly its request hash,
   within 30 s of `prepare` (else `submission_window_closed`; nothing is
   minted). It mints, journals the issue and dispatches once.

Then:

- **A lost submit answer, even lost whole.** The browser still holds the
  prepared journal. A prepared entry counts as possibly sent: it is listed,
  never dropped by the cookie budget, never cancelled, and only read back
  with `loyalty.activity.status` under its original id, across reloads and
  new sign-ins of the same wallet (other launches' journals are read too).
  No other launch submits it, and the page never resubmits it.
- **After the dispatch.** A lost runtime reply, a 5xx, an unavailable
  runtime, an unprovable answer or a thrown error is `outcome_unknown` (or
  unconfirmed), with the issued journal.
- **`not_received`.** Believed only once every assertion the operation could
  have had has expired: 120 s (60 s assertion lifetime plus skew) after its
  recorded issue; for a prepared entry whose issue the browser never
  learned, 120 s after the end of its 30 s window. The prepare time alone
  never proves a later assertion expired. A prepared entry then lapses.
- **Same evidence.** A new `prepare` with the same evidence hash is refused
  (`submission_in_progress`) while an earlier one is unresolved (prepared,
  or issued and not proven).
- **No lost update.** Reads and the join write no launch journal: a slower
  read's cookie could otherwise overwrite a newer prepared one. The page
  runs `prepare`, `submit` and `status` one at a time per launch, and a
  double click starts one submission.
- **Boundary.** A sealed cookie cannot serialise two requests that carry
  the same copy of it. The wallet's existing same-instance damper refuses a
  second `submit` of one operation for 10 minutes. Past it (another server
  instance), only a deliberate replay of the stale prepared cookie within
  its 30 s window can dispatch the same operation again: the same id and
  request hash, never a new id. The runtime's idempotency by `operationId`
  (§4.4) then writes nothing and the wallet keeps it unknown. The normal
  page never sends it.
- **Join** is not journalled: it writes nothing to Dual and is idempotent
  by `operationId`. Its outcome is read back with `loyalty.membership.read`.

## 7. Wallet configuration

- **Binding.** An optional `loyalty` block on a product-face binding, parsed
  exactly. With it absent, the binding has no Loyalty.

  ```
  "loyalty": { "contract": "loyalty-join-earn-v1", "modelId", "programmeId",
               "canonicalTemplateId": Id24, "passTemplateId": Id24,
               "canonicalIssuerAccount": Addr }
  ```

- **Host.** An optional `journeys.loyalty`. Absent is false: old canonical
  bytes and pins are unchanged. When true, it needs a binding with
  `loyalty`.
- **Pages and BFF.**
  - `/products/<slug>/loyalty`: programme, consent, membership and this
    wallet's own submissions.
  - `POST /api/faces/<slug>/loyalty`, with `transition` = `programme`, `join`,
    `membership`, `prepare`, `submit` or `status` (§6). Only `prepare`,
    `submit` and a `status` that closes this launch's own entry carry the
    launch journal back. `prepare` is refused
    (`loyalty_activity_not_permitted`, nothing journalled) unless the
    canonical `state` is `Member` or `Activity verified`. A binding with
    `benefits` adds the transitions of
    [loyalty-benefit-redeem-v1](./loyalty-benefit-redeem-v1.md).
  - A Today-first Home membership card.
  - No iframe.

## 8. Live release blockers (fixtures do not clear these)

1. The Studio runtime leg for §4. Studio tests must prove that join,
   approval and every refusal are zero-write on Dual through the
   assertion-bound leg, with the exact accounting above.
2. The live canonical template body and one real Loyalty write's full map:
   the root fields, `proof_event.public_fields` order and length (the
   evidence hash must survive the existing 12-entry cut), `lifecycle`; and
   whether `update` replaces or merges `custom`. Under merge the runtime
   must still return the full resulting map as `written_custom`, or every
   current receipt fails closed under §5 (5).
3. The participant-custody canary incompatibility
   (`test/participant-opening-canary-incompatibility.test.mjs`).
4. Recipient identity: the pass recipient and `memberId` bound to the
   assertion's holder and wallet instead of generated-app enrolment
   (`walletId == memberId`).
5. Loyalty-specific provider semantics. Root observed these on a Compliance
   pass only; for a Loyalty object, confirm:
   - public object `nonce`, `state_hash` and `content_hash`;
   - state-change `next_nonce` and `next_content_hash` equal the runtime's
     read-back content hash;
   - `affected_objects[].state_change_id`;
   - public action-log `account` for `update`;
   - the holder session's `listObjects` by pass template.
6. `opening_action_id` is the Dual action-log id of the canonical mint (the
   pass snapshot's `canonicalOpeningActionId`).
7. The runtime's idempotency by `operationId` for submit (§4.4,
   `operation_already_received` before every other check), proven by Studio
   tests: the wallet relies on it only past its own same-instance damper.
8. Physical fulfilment, benefits and redemption: out of scope.

## 9. Wallet implementation (source only)

- Domain: `app/_domain/loyalty.ts` (operation allowlist, binding block,
  parsers with exact accounting, the §5 proofs).
- Binding and host: `api/product-face-binding.ts` (`loyalty`),
  `app/_domain/wallet-host.ts`, `api/host-configuration.ts`,
  `api/wallet-host.ts` (`journeys.loyalty`, `loyaltyServedBy`, the home card).
- BFF: `api/product-face-loyalty.ts` and
  `app/api/faces/[slug]/loyalty/route.ts`; provider reads in
  `api/loyalty-provider.ts`; the runtime call `loyaltyRuntimeCall`
  (`api/face-runtime.ts`); journal kind `loyalty`
  (`app/_domain/product-face-journal.ts`, `api/face-journal.ts`).
- Pages: `app/(authorized)/products/[slug]/loyalty/page.tsx`,
  `app/_components/products/loyalty-view.tsx`,
  `app/_components/host/loyalty-today.tsx`.
- Tests:
  - `app/_domain/loyalty.test.ts`;
  - `api/product-face-loyalty.test.ts`: real handlers. It covers wrong
    client, member, pass, pass signer, signer, history, evidence and
    record, a distinct record reference and object id, duplicates, matching
    and non-adjacent verification, pending creation and pass, lost replies
    across reloads and sign-ins, `not_received` only after expiry, and legacy
    bindings and hosts. It also covers:
    - a submit answer lost whole after the write (prepared journal only);
    - a BFF failure after the write;
    - concurrent submits and concurrent prepares;
    - the dispatch window, and `not_received` bounded by the latest
      possible assertion;
    - forged current-nonce submission and verification maps;
    - a named pass beyond the first page, and failed pass reads versus an
      exact empty read;
  - `api/loyalty-provider.test.ts`: the exact pass read;
  - `api/host-loyalty.test.ts`;
  - `app/_components/products/loyalty-view.test.tsx`.
- Browser (FICTIONAL): `npx playwright test -c playwright.loyalty.config.ts`
  (ports 3340, 4340 and 4350; `e2e/loyalty.spec.ts`), including a submit
  answer discarded whole (Set-Cookie too) and a reload with the browser's
  old cookies, and a double click. It runs the real
  wallet against the fake api-v3 with a fictional provider world
  (`e2e/loyalty/world.mjs`, `MOCK_LOYALTY=1`) and a LOCAL FAKE runtime that
  verifies every assertion (`e2e/loyalty/fake-loyalty-runtime.mjs`). The fake
  is not Studio's runtime and proves nothing about it.

# Loyalty join and earn from the branded wallet: `loyalty-join-earn-v1` (PROPOSED)

**Status: proposal for root review. Not implemented, not live.** Every
operation, binding key, journal kind and route below is a PROPOSED name.
Everything else is existing Studio source at `ff977a4`, cited, with provider
behaviour **live-unverified**. Basis: the archived diagnosis
([p4-loyalty-diagnosis.md](../development/p4-loyalty-diagnosis.md)).

## Scope

One member journey, with no event: open programme → join with terms consent →
operator approval → issuer-owned canonical membership plus the member's opening
pass → activity submission → verifier acceptance → the member sees counted
progress. Benefit, redemption, partner confirmation and physical fulfilment
are out of scope (next contract).

## Custody and keys (existing contract, unchanged)

- Canonical membership: issuer-owned; every lifecycle write is signed by the
  Studio runtime's issuer account and passes the existing custody gate
  (`api/purpose-runtime.mjs:3349-3351`).
- Opening pass: minted once by the issuer account, with its separate pass key,
  to the member's wallet; immutable (`src/participant-opening-pass-template.mjs`,
  signer check in `src/participant-opening-pass-outbox.mjs:20`).
- Member: authority is the wallet's existing one-time face assertion
  (holder = the server-read session); the member signs nothing on Dual in
  this contract and never writes the canonical record.
- Staff: programme_operator approves and creates; activity_verifier verifies
  (Studio role sessions, existing).
- Wallet deployment to runtime transport: optional Vercel OIDC workload
  header (wallet `d40ccce`); workload identity only, never holder authority.

## Records (existing schemas; no new Dual keys)

No Dual key is added. The wallet relies on the canonical template's 15
`public_access` fields and the pass's 17 public fields (listed in the
diagnosis). Consent stays private: `termsVersion`, `consentFingerprint` and
`consentHash` of the join request (`src/generated-app-role-requests.mjs:459-462`)
are shown only as the programme's record, labelled cached, never as a Dual
fact. Putting consent on Dual would need a revised template (a new contract
hash, so a new template); existing objects stay unchanged.

## Runtime operations (PROPOSED, existing transport)

`POST <binding.origin>/api/product-face/v1/operations`, one assertion per call,
`request_hash` over `{operation, operationId, target, input}`, server to
server, bounded, no redirects, no cookies; unknown input keys refused.

| Operation (PROPOSED)      | Kind  | Input                                                         | Runtime effect                                                                                                                                                                                                                                                                          |
| ------------------------- | ----- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loyalty.programme.read`  | read  | `{model_id}`                                                  | The open revision's member-facing content: name, headline, member promise, `termsVersion`, consent statement, data use, `consentFingerprint`, activity types and evidence hints (existing `loyaltyJoinProgramme`, `src/loyalty-record-runtime.mjs:571`)                                 |
| `loyalty.join.request`    | write | `{model_id, consent: {accepted, terms_version, fingerprint}}` | The existing role request with the assertion's holder and wallet as subject instead of a generated-app session. **Zero Dual writes**; idempotent by `operationId`; refusals `consent_required`, `consent_changed`, `programme_not_found`                                                |
| `loyalty.membership.read` | read  | `{}`                                                          | `pending_approval`, `approved_pending_creation`, `created_pending_pass` or `active`, with evidence from fresh authenticated exact reads at call time: canonical `{object_id, template_id, issuer_account, opening_action_id, state, readback_hash}` and pass `{object_id, template_id}` |
| `loyalty.activity.submit` | write | `{activity_type, evidence_ref}`                               | Only for an `active` holder: the existing `submit_activity` as role member, issuer-signed, duplicate evidence refused (`loyalty-record-runtime.mjs:329-339`). Returns `submitted` with the action id and readback, or `outcome_unknown`                                                 |
| `loyalty.activity.status` | read  | `{}` (original `operationId`)                                 | `submitted`, `verified` (the `verify_activity` event's action id and readback bound to this submission's evidence hash) or `outcome_unknown`; never resubmits                                                                                                                           |

## What the wallet proves before it says so

- **Active membership.** The holder's own session lists the pass (owner =
  holder, template = the binding's pass template). The pass's
  `canonical_object_id`, `canonical_template_id` and
  `canonical_issuer_account` equal the binding and the runtime's evidence. A
  public read of the canonical object shows owner = that issuer account and
  the template; otherwise "not confirmed".
- **Submitted.** Only the runtime's request-bound answer for this operation,
  plus a canonical public read whose state is `Activity pending` or later.
- **Counted.** Only a `verified` status whose `verify_activity` action
  appears in the canonical object's public state-changes, by the issuer
  account, after the submission. Dual's `state` alone never counts: a later
  submission returns it to `Activity pending`.
- Anything the wallet cannot prove is shown as the programme's record
  (cached) or "not confirmed", never as progress.

## Wallet (PROPOSED)

- Binding: optional `loyalty` block, parsed exactly like `tickets.admission`:
  `{contract: "loyalty-join-earn-v1", canonicalTemplateId, passTemplateId,
canonicalIssuerAccount, modelIds, states: {active, held, ended}}`. Absent
  means no Loyalty.
- Host: optional `journeys.loyalty`, absent = false (old canonical bytes and
  pins unchanged; `api/host-tickets.test.ts:110-114` updated deliberately).
- Routes: `/products/[slug]/loyalty` (programme, join, membership, activity)
  and `app/api/faces/[slug]/loyalty/route.ts` (transitions `programme`,
  `join`, `membership`, `submit`, `status`); a Today-first Home "Membership"
  card. No iframe, no holder executor, no `/api/backend` execution.
- Journal kind `loyalty` (sealed launch cookie): the join and submit
  `operationId` and `request_hash`; reopen reads only the original
  operation's status.

## First release acceptance fixture (FICTIONAL)

Fake api-v3 with an issuer-owned canonical object, the member's pass, and
public object and state-change reads; a local fake runtime verifying every
assertion. Cases: phone keyboard join with consent; pending approval;
creation without a pass is not active; a forged or mismatched pass is
refused; submit, lost reply, reload, status by original operation only;
duplicate evidence; `Activity verified` without a matching issuer-signed
verify event is not counted; another member's records isolated; legacy hosts
unchanged.

## Prerequisites before implementation (root)

1. A Studio test proving join and approval are zero-write on Dual through
   the assertion leg.
2. The live canonical template body and one real write's full custom map;
   whether `update` replaces or merges `custom`.
3. The participant-custody canary incompatibility
   (`test/participant-opening-canary-incompatibility.test.mjs`).
4. Recipient identity: binding the pass recipient to the assertion's holder
   and wallet instead of generated-app enrolment (`walletId == memberId`,
   `api/purpose-runtime.mjs:1114-1121`).
5. Public object, state-change "by whom" and fingerprint semantics, and the
   holder's `objects.read` reach.
6. Gap: there is no `reject_activity`; a refused activity would stay
   `Activity pending` until a transition exists.

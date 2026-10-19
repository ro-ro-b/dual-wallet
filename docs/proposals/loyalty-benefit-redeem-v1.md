# Loyalty benefits and one-time redemption: `loyalty-benefit-redeem-v1`

**Status.** Final wire extension of
[loyalty-join-earn-v1](./loyalty-join-earn-v1.md), for the Studio owner. The
wallet half is implemented in source (§10) and proven only against FICTIONAL
local fakes. The matching Studio runtime leg, the partner leg and real
canonical write, readback and fulfilment evidence do not exist yet; the §9
blockers stand. Studio facts below are cited from the read-only checkout at
`ff977a4`.

Everything in loyalty-join-earn-v1 still applies unchanged:

- transport, assertion, request hash, replay and expiry rules;
- the `CanonicalRead` and `ActionReceipt` types;
- the §5 proof rules, including (5): a receipt at the canonical's own nonce
  carries exactly the fresh full map, and earlier receipts are historical;
- the prepare-before-dispatch recovery of §6.

## 1. What already exists in Studio, and is reused as is

| Need                | Existing Studio source                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle and roles | `src/domain-packs.mjs:228-234`: `unlock_benefit` (Activity verified → Benefit eligible, programme_operator), `request_redemption` (→ Redemption pending, member), `confirm_redemption` (→ Redeemed, benefit_partner), `settle_partner` (→ Member, settlement_operator) |
| Eligibility         | `src/purpose-policy.mjs:698` (record mode: each rule counts only its own activity types, from verified submit/verify pairs)                                                                                                                                            |
| Shared stock        | `src/loyalty-benefit-allocation.mjs`: one app ledger; an allocation per (benefit, record, unlock intent), `reserved` before dispatch, `consumed` only with that unlock's exact proof (`:93, :239, :276`)                                                               |
| Stock proof         | `src/loyalty-record-runtime.mjs:251-322`: an unlock reserves only when every consumed allocation of the benefit matches its own record's verified unlock proof, atomically with the check; refusals are zero-write                                                     |
| Availability view   | `src/loyalty-record-runtime.mjs:465`: `available`, `reserved_pending`, `exhausted`, `proof_unverified`, `proof_partially_checked`; `remaining` is null unless every consumed allocation verified                                                                       |
| One-time reference  | `src/loyalty-record-runtime.mjs:191`: HMAC of the ledger's secret over (app, record, request event), `XXXX-XXXX` from a 32-letter alphabet; never stored or written to Dual, shown to the member only (`:216`)                                                         |
| Single use          | `one_time_nonce` (`src/purpose-policy.mjs:740`) plus the reference check (`src/loyalty-record-runtime.mjs:370`): one confirm per current request                                                                                                                       |
| Partner scope       | `loyaltyPartnerScope` (`src/loyalty-record-runtime.mjs:210`): a benefit is confirmed only by a signed benefit_partner role session whose `partnerId` is the benefit's own                                                                                              |
| Agent redaction     | `loyaltyMcpSafePayload` (`src/loyalty-record-runtime.mjs:453`): MCP never relays the reference                                                                                                                                                                         |
| Member view         | `loyaltyRecordView` (`src/loyalty-record-runtime.mjs:492`): progress, benefits, owned reward, request, confirmation, settlement                                                                                                                                        |
| Terms               | `src/record-purpose-content.mjs:169-202`: benefits (id, title, type, value, partner, stock, `validDays`, terms), partners, rules                                                                                                                                       |

No new lifecycle, signer, custody model, store or Dual field is introduced.
The canonical membership stays issuer-owned and issuer-signed; the opening
pass stays member-held and immutable. Operator, verifier, partner and
settlement actions stay in their own scoped Studio role sessions. The wallet
offers none of them.

## 2. Prerequisites found in the Studio source

The wallet fails closed on each of these until Studio provides it.

1. **Member authority for `request_redemption`.** Studio's member is a
   generated-app session holding the record (`holderOfRecord`,
   `src/loyalty-record-runtime.mjs:216`). The assertion-bound leg must map
   the assertion's holder and wallet to the one record whose
   `memberReference` = sha256(wallet id). This is the same gap as
   loyalty-join-earn-v1 §8 (1) and (4).
2. **Reward expiry is not enforced.** `validDays` reaches only the view and
   fulfilment metadata (`src/record-purpose-content.mjs:309`).
   `not_expired` checks only membership expiry and the campaign window
   (`src/purpose-policy.mjs:749`), and `request_redemption` has no gate
   (`src/domain-packs.mjs:231`). Required: `valid_until` = the verified unlock
   event's time + `validDays`; `request_redemption` and `confirm_redemption`
   refuse after it with zero writes (`loyalty_reward_expired`).
3. **Activity can strand value.** `submit_activity` is allowed from
   `Benefit eligible` and `Redeemed` (`src/domain-packs.mjs:228`):
   - from `Benefit eligible` the unspent reward can no longer be requested
     (`request_redemption` needs `Benefit eligible`), and the next
     `unlock_benefit` overwrites the single `benefitReference`;
   - from `Redeemed`, `settle_partner` can no longer run.

   Required, in the assertion-bound `loyalty.activity.submit` handler only
   (not a domain-pack or global policy rewrite, so other callers are
   unchanged): refuse with `loyalty_activity_not_permitted` and zero writes
   unless the canonical `state` is `Member` or `Activity verified`.

4. **The member's request must name the grant it redeems.** Studio's
   request names no benefit (`src/loyalty-record-runtime.mjs:236`). The
   assertion-bound leg must refuse (`loyalty_reward_changed`, zero writes)
   unless `benefit_id`, `grant_action_id`, `allocation_id` and
   `revision_hash` (§4.2) are exactly the record's current reward.
5. **The partner is not a Dual fact.** `confirm_redemption` is written by
   the issuer account. Its public fields are `action`, `state`, `receipt`
   and `benefitReference` (`src/domain-packs.mjs:232`), with no partner id.
   The wallet shows the partner only as the programme's record. No Dual
   field is added.
6. **Grant–allocation tie.** The wallet ties an allocation to its grant
   through `lifecycle.action_id` =
   `membership-loyalty-rewards_unlock_benefit_<event id>`, where the event id
   is the allocation's intent event (`loyaltyAllocationId`,
   `src/loyalty-benefit-allocation.mjs:93`). The suffix format must be
   confirmed on a live write; if it differs, the grant shows as unconfirmed
   (never as granted).
7. **No fulfilment state exists.** `Redeemed` means the partner recorded the
   redemption. Delivery, and a partner-reported failure after use, have no
   state. The wallet never claims delivery (§6).

## 3. Binding

An optional key on the existing `loyalty` block. With it absent the binding
is exactly loyalty-join-earn-v1 and the wallet makes none of the calls below.

```
"loyalty": { …loyalty-join-earn-v1 keys…, "benefits": "loyalty-benefit-redeem-v1" }
```

## 4. Operations (host-only, member-only; final schemas)

All four target `{model_id, object_id}`, where `object_id` is the canonical
membership. Every answer carries `accounting`, and every refusal has
`dual_writes: 0` and its reason as in loyalty-join-earn-v1.

### Shared types

```
Allocation  = {   // APPLICATION record: the app's shared-stock ledger, not Dual
  "allocation_id": /^alc_[0-9a-f]{32}$/,
  "benefit_id": BenefitId, "event_id": /^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$/,
  "status": "consumed",
  "proof": { "object_id": Id24, "action_id": string } }

BenefitTerms = {  // APPLICATION record: the programme revision's terms
  "benefit_id": BenefitId, "title", "description", "type", "value"?: { "amount": int },
  "partner": { "partner_id", "name" } | null, "valid_days": int, "terms",
  "redeemed_before": boolean }   // a verified confirm of it on this record already

StockView   = {   // APPLICATION record: Studio's availability view
  "stock": int>=0, "remaining": int>=0 | null,
  "status": "available" | "reserved_pending" | "exhausted"
          | "proof_unverified" | "proof_partially_checked" }

VerifiedActivity = {
  "activity_type": ActivityType,          // APPLICATION label (the submission's intent)
  "evidence_hash": Hash,
  "submission": ActionReceipt,            // semantic submit_activity
  "verification": ActionReceipt }         // semantic verify_activity

BenefitId = /^[a-z0-9][a-z0-9-]{1,63}$/
```

New `ActionReceipt.semantic` values, all `action_name: "update"`:
`unlock_benefit`, `request_redemption`, `confirm_redemption`,
`settle_partner`.

### 4.1 `loyalty.benefits.read` (read)

`input: {}`. 200:

```
{ "ok": true, "status": "benefits_read",
  "programme": { "programme_id", "revision_hash": Hash },
  "canonical": CanonicalRead,
  "progress": [ { "rule_id", "label", "activity_types": [ActivityType],
                  "benefit_ids": [BenefitId], "required_verified": 1..100,
                  "verified": int, "pending_verification": 0|1 } ],      // APPLICATION projection
  "verified_activities": [VerifiedActivity],                              // at most 100
  "benefits": [ { ...BenefitTerms, "stock": StockView } ],                // at most 12
  "reward": null | {
     "benefit_id": BenefitId,
     "grant": ActionReceipt,                       // unlock_benefit
     "allocation": Allocation,
     "valid_until": ISO,                           // APPLICATION: grant time + valid_days
     "request"?: ActionReceipt,                    // request_redemption
     "confirmation"?: ActionReceipt,               // confirm_redemption
     "confirmation_recording"?: true,              // APPLICATION: partner confirmation not yet on Dual
     "settlement"?: ActionReceipt },               // settle_partner
  "accounting": { "dual_writes": 0, "reason": "benefits_read" } }
```

`reward` is the record's latest grant and what followed it, and nothing
earlier. `programme.programme_id` must be exactly the binding's
`programmeId`, as `loyalty.programme.read` requires. A read naming another
programme is unavailable: none of its terms, progress or revision is shown or
bound into a request.

### 4.2 `loyalty.redemption.request` (one Dual write by the issuer, on the member's assertion)

`input: { "benefit_id", "grant_action_id", "allocation_id", "revision_hash" }`.
These are ids only, and must be exactly the current reward (§2 (4)). The
runtime runs the existing `request_redemption` as the record's member. It is
idempotent by `operationId`, as `loyalty.activity.submit` is
(loyalty-join-earn-v1 §4.4).

| HTTP | `status`                                                                                                                                                                             | Body                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 200  | `redemption_requested`                                                                                                                                                               | `canonical`, `grant`, `allocation`, `action` (request_redemption), `accounting {1, "redemption_requested"}`; no reference |
| 409  | `loyalty_redemption_not_permitted`, `loyalty_reward_changed`, `loyalty_reward_expired`, `loyalty_reward_unverified`, `loyalty_redemption_already_requested`, `membership_not_active` | `accounting {0, <status>}`                                                                                                |
| 409  | `operation_already_received`                                                                                                                                                         | `accounting {0, …}`: not a refusal; the wallet keeps it unknown                                                           |
| 202  | `outcome_unknown`                                                                                                                                                                    | `accounting {"unknown", "outcome_unknown"}`                                                                               |

### 4.3 `loyalty.redemption.status` (read, the original operation only)

`operationId` is the original request's; `input: {}`. As in r20's echoed
binding ([runtime-write-status-r20](./runtime-write-status-r20.md)), every
answer echoes `operation_id`. `requested`, `confirmation_recording` and
`confirmed` also echo the `request_hash` the runtime recorded for that
operation. An answer is this operation's outcome only when both equal the
journalled operation id and request hash: the same grant is not enough. A
committed answer for another operation is unconfirmed, and a `not_received`
naming another operation (or none) is unknown and closes nothing.

| `status`                 | Body                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `requested`              | `operation_id`, `request_hash`, `binding` (the four ids of §4.2), `canonical`, `grant`, `allocation`, `action` (request), `valid_until` |
| `confirmation_recording` | as `requested`: the partner's confirmation is recorded by the programme but not yet written to Dual (APPLICATION)                       |
| `confirmed`              | as `requested`, plus `confirmation`, and `settlement` once recorded                                                                     |
| `not_received`           | `operation_id`, `accounting {0, "operation_not_received"}`: the runtime never accepted it and, its assertion having expired, never can  |
| `outcome_unknown` (202)  | `accounting {"unknown", "outcome_unknown"}`                                                                                             |

### 4.4 `loyalty.redemption.reference` (read, explicit, member only)

`input: { "request_action_id" }`: the Dual action id of the record's
current request, as `loyalty.benefits.read` showed it. `operationId` is a
fresh read id, not the request's, so the member can show the reference from
any device or session, even after the request's journal has expired. It is
asked only when the member chooses to show it.

| HTTP | `status`                         | Body                                                                                                                                                      |
| ---- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200  | `reference_shown`                | `reference` (`/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/`), `canonical`, `grant`, `allocation`, `action` (this request), `accounting {0, "reference_shown"}` |
| 409  | `loyalty_redemption_not_current` | `accounting {0, …}`: the request was confirmed, expired, held or replaced; no reference                                                                   |

The reference is the existing HMAC one: the same request always shows the
same reference, and a new one is never minted. It is never written to the
journal, a log, a URL, browser storage, the Home card or any agent or MCP
output. It reaches only the member's page, in the answer to this read. The wallet
shows it only when the request's receipt is the canonical's **current** state
(§5 (5)) and its whole chain proves.

## 5. What the wallet proves

**Receipts.** Each receipt passes loyalty-join-earn-v1 §5 (1)–(5): signer,
provider history, and current versus historical. Its written map must also
have:

| Semantic             | `state`              | Root `benefitReference` | `proof_event.public_fields` has | `lifecycle.action_id` starts |
| -------------------- | -------------------- | ----------------------- | ------------------------------- | ---------------------------- |
| `unlock_benefit`     | `Benefit eligible`   | the benefit             | `benefitReference:<benefit>`    | `…_unlock_benefit_`          |
| `request_redemption` | `Redemption pending` | the benefit             | (nothing more)                  | `…_request_redemption_`      |
| `confirm_redemption` | `Redeemed`           | the benefit             | `benefitReference:<benefit>`    | `…_confirm_redemption_`      |
| `settle_partner`     | `Member`             | (not checked)           | (nothing more)                  | `…_settle_partner_`          |

**The reward chain.** Each step must be the very next change to the
canonical object after the one before:

- request `next_nonce` = grant + 1;
- confirmation = request + 1;
- settlement = confirmation + 1.

No other action can stand in for a step of this reward.

**Grant.** The grant receipt passes. The allocation is `consumed` and its
`allocation_id` is `alc_` + the first 32 hex of sha256(benefit id, record
id and event id, newline-separated), the record id being the canonical
`custom.recordId`. Its `proof` names the canonical object and the grant's
action id, and the grant's `lifecycle.action_id` ends with
`_unlock_benefit_<event_id>`. Without all of this, the reward is shown as
unconfirmed, never as granted.

**Verified eligibility.** At least `required_verified` distinct verified
pairs of the rule's activity types. In each pair:

- the submission passes with its evidence hash;
- the verification passes and is the very next change after it;
- both are on this canonical object;
- no action id is counted twice.

The activity type is the programme's label. `progress` is shown as the
programme's own count, apart from this.

**Stock.** The programme's record, never a substitute for the reward's
canonical state. It is shown as available only for `available` with
`remaining` > 0, as unavailable only for `exhausted`, and otherwise as "can't
be confirmed".

**Programme and revision.**

- The programme id is proven twice:
  - the answer's `programme_id` is the binding's (§4.1);
  - the canonical `custom.programmeId` is too (loyalty-join-earn-v1 §5).
- The `revision_hash` is the programme's APPLICATION record of the record's
  governing revision. The wallet can't prove it: the binding names no
  revision, and the canonical map carries none.
- The wallet checks its form and binds it into the request's binding and
  request hashes. A request is therefore for exactly the revision the
  member saw, and its status must echo the same.
- Studio refuses a request whose revision is not the record's governing one
  (`loyalty_reward_changed`, §2 (4)).
- The wallet does not compare it with `loyalty.programme.read`'s revision.
  That revision is the catalog's current one, which may legitimately differ
  from an existing member's governing revision.

**Per benefit, the wallet shows exactly one of:**

| Status                   | When                                                                        |
| ------------------------ | --------------------------------------------------------------------------- |
| `locked`                 | not eligible by the programme's count                                       |
| `eligible_unconfirmed`   | the programme says eligible; the wallet cannot prove the pairs              |
| `eligible`               | proven eligible; availability shown separately; next: the programme team    |
| `already_redeemed`       | the programme records a verified redemption of it on this record before     |
| `granted` / `expired`    | proven grant, current state `Benefit eligible`; expired after `valid_until` |
| `requested`              | proven request adjacent to the grant; next: the partner                     |
| `confirmation_recording` | the programme recorded the partner's confirmation, not yet on Dual          |
| `confirmed`              | proven confirmation adjacent to the request; delivery not tracked           |
| `settled`                | proven settlement adjacent to the confirmation (a record, not a payment)    |
| `not_redeemable`         | proven, but a later change made it no longer the record's current state     |
| `unconfirmed`            | any proof in the reward's chain fails                                       |

`held` (canonical `Suspended`) and `ended` (`Expired`) hide every member
action and keep the reward's last proven step, labelled as the past.

## 6. Member actions and the next actor, by canonical state

| State                  | Member may                     | Shown next actor                                         |
| ---------------------- | ------------------------------ | -------------------------------------------------------- |
| `Member`               | submit an activity             | –                                                        |
| `Activity pending`     | nothing                        | the programme verifies the last activity                 |
| `Activity verified`    | submit an activity             | the programme team grants an eligible, available benefit |
| `Benefit eligible`     | request redemption (unexpired) | – (an expired reward: the programme team)                |
| `Redemption pending`   | show the reference             | the partner confirms                                     |
| `Redeemed`             | nothing                        | the programme records the partner settlement             |
| `Suspended`, `Expired` | nothing                        | the programme team                                       |

The wallet refuses to prepare an activity outside `Member` and
`Activity verified` (`loyalty_activity_not_permitted`, nothing journalled).
That is §2 (3) on the wallet's side.

**Fulfilment.** `confirmed` reads "The partner recorded your redemption".
The wallet has no delivery state, never shows one, and never offers a second
request for a confirmed reward. If the member did not receive the benefit,
the page says to contact the programme team with the redemption's date. The
reward stays exactly as recorded: no completed screen, no new request.

## 7. Recovery

A member request is the same two-step durable submission as an activity
(loyalty-join-earn-v1 §6):

1. **`prepare`.** The wallet re-proves the reward `granted` and unexpired
   from fresh reads. It then journals:
   - kind `loyalty`, operation `loyalty.redemption.request`;
   - the benefit id, the exact request hash, and the **binding hash**:
     sha256 of canonical JSON of the four ids.
2. **`submit`.** Within 30 s, exactly once.

The prepared or sent request is listed and only status-read under its
original id, across a lost or whole-lost answer, an exception after the
dispatch, a 401 or 403, a reload or a new sign-in. A status answer counts
only if it echoes exactly this operation's id and recorded request hash
(§4.3), and its `binding` hashes to the journalled binding hash.

A second request for the same grant is refused (`redemption_in_progress`)
while one is unresolved. A refused request (an exact listed zero-write
refusal) is settled as not submitted.

A copied or re-shown reference is the same reference; it never creates an
operation, and a reused one is refused by the partner leg (no current request
is left to confirm). `not_received` follows the same bound as an activity.

## 8. Wallet surfaces

- **The Loyalty page:**
  - the programme's progress;
  - each benefit's terms, status and availability;
  - the reward with its next actor;
  - "Request redemption";
  - "Show my one-time reference" and "Hide";
  - this wallet's own requests, each with "Check status".
- **The Home card:** the membership's status and one reward line, from the
  same read; never the reference.
- **Identity change.** Transient page state, the reference included, is
  keyed by the wallet and the programme and cleared on sign-out or a change
  of identity.

## 9. Live release blockers (the fixtures clear none)

1. The Studio runtime leg for §4, with §2 (1)–(4), and tests proving every
   refusal zero-write through the assertion-bound leg.
2. A real grant, request, confirmation and settlement on a Loyalty canonical
   object. They must confirm:
   - the written maps and root `benefitReference`;
   - the `public_fields` entries;
   - the `lifecycle.action_id` suffix (§2 (6));
   - adjacency in the provider history.
3. Studio's availability view and allocation records, exposed exactly as
   §4.1, with the proof-coverage statuses unchanged.
4. Reward expiry enforcement (§2 (2)).
5. The partner leg: a scoped benefit_partner session presenting the member's
   reference. This is Studio's existing role session, untouched by the
   wallet.
6. Fulfilment, delivery and partner-reported failure: out of scope (§2 (7)).
7. **Governing revision.** The revision a reward's terms and progress come
   from is not provable by the wallet (§5, programme and revision). Making
   it provable would need Studio to publish the governing revision where
   the wallet can verify it, such as a provable field or a signed
   statement. That is a later contract decision, not a new field now.
8. The r20 operation echo on `loyalty.redemption.status` (§4.3), in the
   Studio runtime leg.
9. Everything still open in loyalty-join-earn-v1 §8.

## 10. Wallet implementation (source only)

- **Domain.**
  - `app/_domain/loyalty-benefits.ts`: the exact parsers, the allocation
    tie, chain adjacency, eligibility from proven pairs and the
    member-safe views.
  - `app/_domain/loyalty.ts`: the binding key, the four host operations,
    the reward receipt semantics, and the activity state gate with
    `loyalty_activity_not_permitted`.
  - `app/_domain/product-face-journal.ts`: operation
    `loyalty.redemption.request`, with `benefitId`.
- **BFF.**
  - `api/product-face-loyalty-benefits.ts`: read, prepare, submit, status
    and reference.
  - `api/product-face-loyalty.ts`: the shared single dispatch
    (`dispatchPrepared`) and the shared proofs.
  - Route transitions `benefits`, `redeem_prepare`, `redeem_submit`,
    `redeem_status` and `reference`.
- **Page and Home.**
  - `app/_components/products/loyalty-benefits.tsx`;
  - `app/_components/products/loyalty-view.tsx` (the activity offered only
    as §6 permits);
  - `app/_components/host/loyalty-today.tsx` (one reward line);
  - `app/_services/loyalty.client.ts` and the `loyalty.benefits` query.
- **Tests.**
  - `api/product-face-loyalty-benefits.test.ts`: real handlers over a
    member-keyed FICTIONAL world with one shared stock ledger. It covers
    progress versus proven eligibility; non-adjacent or reused pairs; stock
    without proof coverage; two members and the last unit; the full grant,
    request, reference, confirmation, settlement and reopen; a stranding
    activity refused; a request lost whole; a failure after the write;
    concurrent submits; a foreign binding in a status answer; a refusal
    settled; and, never granted or never current:
    - a forged current grant map;
    - a wrong signer, object or action;
    - an allocation backing another action or another intent;
    - a missing allocation;
    - a non-adjacent request;
    - a historical grant naming another benefit;
    - a stale reference;
    - expired, held, recording and stranded rewards;
    - another member's or another record's canonical;
    - the reference kept out of the journal and cookies.
    - a benefits answer naming another programme (no view, no prepare, no
      dispatch);
    - a status answer for another operation, another request hash or with
      no echo, and a `not_received` naming another operation.
  - `app/_domain/loyalty-benefits.test.ts`.
  - `app/_components/products/loyalty-view.test.tsx`.
- **Browser (FICTIONAL)**, `e2e/loyalty.spec.ts`: at phone width from the
  keyboard:
  - two verified activities;
  - the operator's grant;
  - one request whose whole answer is lost, then a reload with the old
    cookies;
  - the reference;
  - a wrong, right and reused partner confirmation;
  - settlement, then the Home card and a fresh reopen.

  The fake runtime (`e2e/loyalty/fake-loyalty-runtime.mjs`) is not Studio.
  The partner and operator are test hooks. Nothing physical is fulfilled or
  claimed.

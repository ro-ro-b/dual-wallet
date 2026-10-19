# P4 Loyalty: read-only custody diagnosis (archive)

Read-only diagnosis of Studio `ff977a4` (governed-workflow-studio-app) and the
wallet at `03f34b5`, accepted by root as the basis for Loyalty. Nothing here
is implemented in the wallet. Provider behaviour quoted from the generated SDK
or Studio source is **live-unverified**: no live API was called.

## Decisive finding

- Studio updates a membership only when the runtime's own signer
  (`GET /wallets/me`) equals the object's current owner and the expected
  issuer account (`api/purpose-runtime.mjs:3317-3351`, status
  `purpose_update_custody_issuer_authority_required`). An issuer can never
  update a member-held object, and no delegation path exists in source
  (`api/purpose-runtime.mjs:3281-3284`).
- `participant_managed` birth mints the membership to the member, after which
  the member's `submit_activity` is refused with zero writes
  (`test/loyalty-records-participant-birth.test.mjs:72-93`). The full
  lifecycle is proven only issuer-held
  (`test/loyalty-records-redemption-partner.test.mjs`).
- A member-owned record cannot carry business states: on Dual an owner can
  write any custom map, so verifier, operator and partner states on it would
  be self-authorisable.

## Leading approach (existing, reused)

`participant-opening-pass-v1` (`src/generated-participant-custody.mjs`,
`src/participant-opening-pass*.mjs`): the canonical membership stays
issuer-owned and carries the whole lifecycle; the member receives a separate,
immutable opening pass on its own template, minted by the issuer account to
the member's wallet, `mint` only (`src/participant-opening-pass-template.mjs`).
Membership is verified only when the canonical owner is the issuer **and** a
fresh pass read shows the member's wallet as owner
(`api/purpose-runtime.mjs:1102-1131`).

## Existing lifecycle (`src/domain-packs.mjs:227-236`)

Every row after birth is an issuer-signed update of the canonical record;
leaves are its public root fields plus the activation envelope.

| Action                       | From → to                                                                | Role                                         |
| ---------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| `create_membership`          | → Member                                                                 | owner / programme_operator                   |
| `submit_activity`            | Member, Activity verified, Benefit eligible, Redeemed → Activity pending | member                                       |
| `verify_activity`            | Activity pending → Activity verified                                     | activity_verifier                            |
| `unlock_benefit`             | Activity verified → Benefit eligible                                     | programme_operator (rules and stock)         |
| `request_redemption`         | Benefit eligible → Redemption pending                                    | member                                       |
| `confirm_redemption`         | Redemption pending → Redeemed                                            | benefit_partner (scoped, one-time reference) |
| `settle_partner`             | Redeemed → Member                                                        | settlement_operator                          |
| suspend / reinstate / expire | various                                                                  | programme_operator                           |

Join is a generated-app role request with
`consent {accepted, termsVersion, fingerprint}`; only hashes are kept and
approval is human (`src/generated-app-role-requests.mjs:402-462`). Stock and
the redemption reference live in an app ledger
(`src/loyalty-benefit-allocation.mjs`). No activity rejection transition and
no physical fulfilment state exist.

## Schemas (existing)

- Canonical template (`src/generated-app-provisioning.mjs:474-521`):
  `public_access.custom` is `recordId`, `title`, `memberReference`,
  `programmeId`, `state`, `tierStatus`, `eligibilitySummary`,
  `benefitReference`, `redemptionStatus`, `activation_hash`,
  `recipient_mint_projection`, `product_type`, `app_namespace`,
  `operation_id`, `idempotency_key`. A write's actual custom map is larger:
  an owner-record envelope, these root fields and a nested `custom`
  (`src/dual-activation.mjs:999-1095`).
- Opening pass (`src/participant-opening-pass-template.mjs`): public
  `passType`, `canonicalOpeningReference`, `participantReference`,
  `openingState`, `openingSnapshotHash`, `acknowledgement`, `schema`,
  `product_type`, `canonical_object_id`, `canonical_template_id`,
  `canonical_issuer_account`, `organization_id`, `opening_action_id`,
  `opening_snapshot_hash`, `activation_hash`, `idempotency_key`,
  `operation_id`. The outbox also writes `app_namespace`, `instance_id`,
  `release_id` and `recipient_mint_projection`, which the template does not
  declare (`src/participant-opening-pass-outbox.mjs:10`).
- Consent is a private field by design (`consentRecord`,
  `src/domain-packs.mjs:240`): no consent leaf exists on Dual.

## Canonical readback versus cached status

| Kind                         | Source                                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical, authenticated     | Studio's same-client exact reads at write time (`dualProof`, `loyalty-record-runtime.mjs:116-124`; pass `confirmedProof`, outbox `:20, :54`)                           |
| Canonical, recovery          | `reconcile_dual` for unresolved outbox intents only (`api/purpose-runtime.mjs:6227-6250`)                                                                              |
| Canonical, public (provider) | `GET /public/objects/{id}` and `GET /public/objects/{id}/state-changes` (no sign-in), `GET /objects/{id}` (`objects.read`), per the generated SDK: **live-unverified** |
| Cached app status            | member view, eligibility projection, stock, join consent hash, redemption key ("Nothing here contacts Dual", `loyalty-record-runtime.mjs:26-27`)                       |

## Open prerequisites (root)

Consent and canonical zero-write proof; the actual live template and map;
the participant-custody canary incompatibility
(`test/participant-opening-canary-incompatibility.test.mjs`); the pass
recipient's identity from the branded wallet (today generated-app enrolment,
`walletId == memberId`); public object and state-change semantics; whether
`update` replaces or merges `custom`; physical fulfilment. The proposed
join/earn contract is [loyalty-join-earn-v1](../proposals/loyalty-join-earn-v1.md).

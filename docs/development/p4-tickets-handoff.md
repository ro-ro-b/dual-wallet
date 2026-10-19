# P4.2 Tickets wallet handoff

Base (accepted): `6fc584d9b79b4ebfcabc2bb9a5d538b8c3bbf88e`. Checkpoint
(unaccepted when received): `8c66e093c554a39254de65b9ad9a9e283c2736e4`, a
direct child of the base. The final source commit is reported with the push.
This is source-level work only: it is not deployed, and no hosted, live Dual or
holder acceptance is claimed.

## Customer behaviour

On a separately provisioned branded wallet whose configuration sets
`journeys.tickets: true` (and whose face binding declares `tickets` rules):

- `/products/<slug>/tickets` lists only the signed-in account's own tickets,
  with the event, time, ticket class and an honest status, a "show more"
  continuation, and a distinct unavailable state with Try again.
- Paging keeps context: "Show more" keeps keyboard focus while it loads
  (`aria-disabled`, pending text); reaching the last page moves focus to an
  announced "All your tickets are shown." status; a failed later page keeps
  the tickets already listed and focuses an alert whose Try again resumes
  from the same continuation; an ended session offers sign-in back to the
  list.
- `/products/<slug>/tickets/<object id>` shows one exact ticket: event, when,
  where, ticket class, the original issue reference and entry guidance.
- A signed-out visit, or an expired session, signs in and returns to the exact
  page (`safeReturnPath`); a direct reopen reads the ticket afresh.
- Status: `issued`, `pending` (being issued, not valid yet), `ended`, or
  `unconfirmed`. Issued and pending require the original issue operation
  identity on the object; anything the binding does not recognise is
  `unconfirmed`, never issued.
- Without `tickets.admission` on the binding, admission is a constant "not
  available yet" and no state is read as admitted, used or checked in. With
  it (P4.3, below), Dual's admission target state reads only "Entry
  recorded", never entry by itself.
- Missing capability (no ticket rules, journey off, generic wallet) is 403 /
  not found, shown as unavailable. A failed upstream read is "unavailable",
  never "no tickets".

## Today-first home (Tickets hosts)

A returning signed-in customer on a Tickets host sees, under the brand
headline, their Today, Coming up and Needs attention tickets from the first
Tickets page, each linking to the exact ticket, and "See all your tickets".
See [branded wallet hosts: Home and navigation](../branded-wallet-hosts.md#home-and-navigation)
for the rules. Paths: `app/page.tsx`, `app/_components/host/{host-home,tickets-today}.tsx`,
`app/_domain/tickets-today.ts`, `HostHomeView.tickets` (`api/wallet-host.ts`,
`app/_domain/wallet-host.ts`), `messages/en.json` (`host.today`),
`app/globals.css`; tests `app/_domain/tickets-today.test.ts`,
`app/_components/host/tickets-today.test.tsx`, `app/page.test.tsx`,
`api/host-tickets.test.ts`.

### Fictional Tickets/Home browser fixture

A separately named, opt-in fixture runs the real wallet (`next dev`) as the
made-up "Harbour Nights" branded host against the local fake API with opt-in
ticket objects (`MOCK_TICKETS=1` in `e2e/mock-api.mjs`; without it the fake API
is unchanged). Every value is fictional; the host configuration is built and
pinned per run (`e2e/tickets-home/environment.mjs`) and validated by the
wallet's own parser; session and signing keys are generated per process.

- Browser suite: `npx playwright test -c playwright.tickets-home.config.ts`
  (set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` where the installed Playwright's
  Chromium build is not present).
- Persistent walk: `node e2e/tickets-home/serve.mjs`, then open
  `http://localhost:3310/`. Ports: `TICKETS_FIXTURE_WALLET_PORT` (3310) and
  `TICKETS_FIXTURE_API_PORT` (4310). Fictional sign-in:
  `face-e2e@example.com` / `correct horse battery staple`; second holder
  `face-e2e-b@example.com` / `another correct horse battery`. Fixture modes
  (local fake only): `POST http://127.0.0.1:4310/__test__/tickets` with
  `{"mode":"emptyWithMore"|"unavailable"|"normal"}`, `{"expireSessions":true}`
  or `{"reset":true}`.
- It cannot run alongside another `next dev` in the same checkout (Next.js
  holds one dev lock per project directory); use a separate checkout.
- Fixture success is not hosted or customer acceptance.

## P4.3 holder-confirmed admission (ticket-admission-v1, source only)

The contract is [p4-3-admission-contract.md](p4-3-admission-contract.md); its
§11 lists the wallet paths and tests. In short, only for a binding whose
`tickets.admission` block matches the contract exactly:

- The ticket page offers "Check for entry request" (the holder's own fetch, no
  polling), a native confirmation of server-read facts, and signs exactly the
  confirmed four-leaf update through the existing executor after this
  request's own won reservation. "Entry confirmed" only from the runtime's
  request-bound verification plus the wallet's own fresh Dual read.
- Every transition after `begin` is bound to the exact ticket in the URL; an
  operation sent through another ticket's path is refused with no runtime,
  provider or executor call.
- The whole page stays coherent: the ticket status `admission_recorded`
  ("Entry recorded") on detail, home and list; the header "Entry confirmed"
  only after a verified entry and a later Dual read that agrees; an open pass
  re-read after any outcome that may follow a write, so the original birth
  operation and action are shown before and after while no pre-entry
  `operation_readback: current` is kept.
- Legacy bindings are unchanged. The browser proof
  (`npx playwright test -c playwright.tickets-admission.config.ts`) runs
  against a LOCAL FAKE runtime and fake api-v3 only; the shared Tickets
  service's matching leg is Studio's to implement and is not live.

## Boundaries kept

- Existing brands are unchanged: `tickets` is optional and absent means false;
  canonical bytes, approved hashes and the readback of older hosts are
  unchanged. The generic wallet never serves Tickets.
- Reads use the generated `listObjects` (owner and template filters, never
  organisation-wide) and `getObjectById`, with the session's own credential
  behind the face BFF. Object, template, client (organisation), holder and the
  original issue operation identities are preserved in the projection.
- Each object is re-checked server side: programme template, the host's
  organisation (`wrong_client`) and current holder (`not_owned`). The detail
  route answers the same `not_found` for all refusals.
- Tickets are wallet-native pages with no iframe and no bridge capability; the
  face slot renders no frame on these routes. Nothing is journaled or written;
  existing native confirmation, registry and session scopes are untouched.
- No dependency, generated SDK or lockfile change.

Merged: the accepted Phase3 recovery-holding fix
`3c9f3c13cab586497e43070c60b46dad095c9030` (merge `86db46c`).

## Changed paths

- Host: `app/_domain/wallet-host.ts`, `api/host-configuration.ts`,
  `api/wallet-host.ts`, `api/host-journey-guard.ts`,
  `api/product-face-binding.ts` (`tickets` rules).
- Domain/adapters/services: `app/_domain/tickets.ts`,
  `app/_adapters/tickets.ts`, `api/product-face-tickets.ts`,
  `app/_services/tickets.client.ts`, `app/_hooks/{use-tickets,query-keys,query-options}.ts`.
- Routes: `app/(authorized)/products/[slug]/tickets/[[...ticket]]/page.tsx`,
  `app/api/faces/[slug]/tickets/route.ts`,
  `app/api/faces/[slug]/tickets/[objectId]/route.ts`.
- UI: `app/_components/products/{tickets-view,product-face-slot}.tsx`,
  `app/globals.css`, `messages/en.json`.
- Tests: `api/host-tickets.test.ts` (including proxy sign-in return, direct
  reopen and journey-off refusal), `api/product-face-tickets.test.ts`,
  `app/_domain/tickets.test.ts`, `app/_components/products/tickets-view.test.tsx`.
- Docs: `docs/branded-wallet-hosts.md`, `docs/external-face-integration.md`,
  `docs/README.md`, this file.

## Residual risks

- Fixtures and mocked handlers prove the wallet's rules, not hosted behaviour
  or real Dual data. Nothing was run against live Dual, a provider or a holder.
- Listing is bounded: one Tickets request makes at most
  `MAX_UPSTREAM_READS` (4) upstream `listObjects` reads. When they find no
  ticket the response is an empty page **with** a continuation, which the list
  shows as "No tickets found yet" with "Keep checking for tickets", never as
  "no tickets". An upstream continuation that comes back within one request
  (the one it started from included), or one longer than a ticket cursor can
  carry, is an upstream failure (502, shown as unavailable). A cycle longer
  than one request's budget cannot be detected statelessly; it costs at most
  four reads per press of "Keep checking", never an automatic loop.
- Ticket text comes from the object's custom fields as plain, bounded text. A
  brand that stores richer content gets none of it rendered.
- **Install toolchain.** The reviewed `package-lock.json` is byte-identical
  on the accepted base `6fc584d` and on `7579a32` (sha256 prefix `03f74bb9`),
  and this change touches neither `package.json` nor the lock. It installs with
  `npm ci` on npm 11 and is rejected by npm 10: the lock holds
  `@swc/helpers@0.5.15` (pinned by Next.js) while `next-intl`'s optional peer
  asks for `>=0.5.17`, which npm 10's `npm ci` reports as "Missing:
  @swc/helpers@0.5.23 from lock file". The production `Dockerfile` builds on
  `node:24-alpine` (npm 11), so the lock is correct for the supported
  toolchain and was left unchanged. Use Node 24 with npm 11; the `>=20.9.0`
  engine floor is Node only and Node 20/22's bundled npm 10 will not `npm ci`.

## Contract needed from the backend and Studio

The wallet fails closed without it:

1. **Studio** publishes, per ticketing face, a registry binding `tickets`:
   `{fields: {event, issueOperation, state, startsAt?, venue?, entryClass?,
entryGuidance?}, states: {pending, issued, ended}}` (exact dotted custom
   paths; disjoint state lists; non-empty `issued`), plus `journeys.tickets:
true` in the approved host configuration. Studio's validator must agree with
   `api/host-configuration.ts` and `ticketRules` in
   `api/product-face-binding.ts`.
2. **Issuer / shared services** must write the original issue operation
   identity (`[A-Za-z0-9][A-Za-z0-9._:-]{0,159}`) and the state on the ticket
   object at those paths when issuing, and the object must be owned by the
   holder and issued by the host's organisation. Without it a ticket shows as
   not confirmed, by design.
3. `listObjects` must honour the `owner` + `templateId` filters for a holder's
   own token (the existing contract); if it does not, the list is unavailable
   rather than broadened.

## Install and verification evidence (isolated scratch copies)

Each run used `git archive` of the exact commit extracted to its own scratch
directory; the working checkout, its `node_modules` and the branch were not
touched. An earlier version of this file said the failure was reproduced on
the base; that had not been run at the time and was corrected after the runs
below.

| Commit    | Toolchain                      | `npm ci`                                                                                                      |
| --------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `6fc584d` | Node 22.22.0 / npm 10.9.4      | fails: Missing `@swc/helpers@0.5.23` from lock                                                                |
| `7579a32` | Node 22.22.0 / npm 10.9.4      | fails: same error                                                                                             |
| `6fc584d` | npm 10.8.2                     | fails: same error                                                                                             |
| `6fc584d` | npm 11.6.2 and npm 11 (latest) | succeeds (731 and 729 packages)                                                                               |
| `7579a32` | Node 24.22.0 / npm 11.21.1     | succeeds; `npm run check` 76 suites, 1394 tests; `npm run build` succeeds, including the three Tickets routes |

The final commit's `npm run check` and `npm run build` are reported on the
same Node 24 / npm 11 path (see the delivery message for the exact commit).

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
- Admission is a constant "not available yet" (P4.3). No state is read as
  admitted, used or checked in.
- Missing capability (no ticket rules, journey off, generic wallet) is 403 /
  not found, shown as unavailable. A failed upstream read is "unavailable",
  never "no tickets".

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

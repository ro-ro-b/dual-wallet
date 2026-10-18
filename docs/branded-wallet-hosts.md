# Branded wallet hosts

A branded wallet host is a separate deployment of this wallet engine for one
brand and one Dual organisation, with its own domain, origin, secrets and
session. It is built from the same engine commit as every other host and
differs from them **only by environment**. There is no brand-specific source,
branch or build flag; the engine stays one reviewed implementation of sign-in,
sessions, authority, native signing and the product-face host
([dedicated applications](./dedicated-applications.md): products share code,
never forks).

Without a host configuration the deployment is the generic wallet, unchanged.

## What a host deployment is made of

| Variable                                                                | Kind               | Supplied by                   | Meaning                                                                                                           |
| ----------------------------------------------------------------------- | ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `WALLET_HOST_CONFIGURATION`                                             | value, build input | Studio (approved document)    | The canonical JSON host configuration below.                                                                      |
| `WALLET_HOST_CONFIGURATION_SHA256`                                      | value              | Studio                        | Its pin: lowercase hex sha256 of exactly those UTF-8 bytes.                                                       |
| `NEXT_PUBLIC_APP_URL`                                                   | value, build input | Root                          | Must have the same origin as `entrance.origin`.                                                                   |
| `PRODUCT_FACE_APPLICATIONS`                                             | value, build input | Studio (face publication)     | The face registry; it must hold every face the configuration names. It also feeds the CSP `frame-src`, unchanged. |
| `API_URL`                                                               | value              | Root                          | As for the generic wallet.                                                                                        |
| `SESSION_SECRET`, `FACE_ASSERTION_SIGNING_KEY`, `FACE_ASSERTION_KEY_ID` | **secrets**        | Root (per host, never Studio) | Own values per host. Stable across redeploys of that host.                                                        |
| `VERCEL_GIT_COMMIT_SHA`                                                 | platform           | Vercel                        | Read back as `engine.commit` only when the build recorded none (see below).                                       |
| `DEFAULT_ORGANIZATION_ID`, `VIEWER_BASE_DOMAIN`                         | ignored            | -                             | A configured host resolves exactly its entrance organisation; neither applies.                                    |

Leave both host variables unset (or empty) for the generic wallet. Setting
either one makes the deployment a branded host, which must then be entirely
valid (see [Fail closed](#fail-closed)).

### The configuration is a build input

Static pages render the host's identity at build time. `next.config.ts`
records the sha256 of the `WALLET_HOST_CONFIGURATION` a build rendered as
`WALLET_HOST_BUILD_CONFIGURATION_SHA256` (empty for the generic wallet) and,
for a brand, the sha256 of the `PRODUCT_FACE_APPLICATIONS` it validated that
configuration's faces and journeys against as
`WALLET_HOST_BUILD_FACE_APPLICATIONS_SHA256`. The server refuses to serve
under any other configuration or registry (503, `build_mismatch`): a generic
build never serves a brand and a brand build never serves another brand or
the generic wallet. `NEXT_PUBLIC_APP_URL` needs no record, because Next.js
inlines it into the build, server code included; the generic wallet's
registry is not pinned and behaves as before. On Vercel each brand host is
its own project, built with its own environment from the engine commit, so
this holds by construction. A
container image built without the configuration (the Cloud Run Makefile
targets) cannot become a brand host by runtime environment alone; it answers
503 until it is rebuilt with the configuration.

## Configuration schema `dual-wallet-host-configuration-v1`

The document is **exact**: every key below is required, no other key is
accepted, and the bytes must be the canonical JSON form (object keys sorted,
no whitespace; `canonicalJson` in `app/_domain/product-face.ts`). It holds no
number, so the canonical form is unambiguous. The whole document is at most
64 KiB.

```json
{
  "brand": {
    "description": "Register, look after and pass on your Morrow Home tools.",
    "id": "morrow-home",
    "name": "Morrow Home",
    "shortName": "Morrow"
  },
  "entrance": {
    "organizationId": "a1a1a1a1a1a1a1a1a1a1a1a1",
    "origin": "https://wallet.morrow.example"
  },
  "faces": ["morrow-home"],
  "home": {
    "headline": "Your Morrow Home tools, registered and cared for.",
    "introduction": "Register a new tool, follow a service and pass it on when you sell it.",
    "primaryJourney": "registration"
  },
  "identity": {
    "colours": {
      "actionPrimary": "#1d5c41",
      "actionPrimaryHover": "#154631",
      "border": "#d5e2da",
      "brand": "#2f7d5b",
      "brandSoft": "#e6f4ec",
      "brandStrong": "#1d5c41",
      "ink": "#10261c",
      "muted": "#4d6358",
      "onActionPrimary": "#ffffff",
      "surface": "#ffffff",
      "surfaceSubtle": "#f4f7f5"
    },
    "logo": {
      "dataBase64": "<canonical base64 of the image>",
      "mediaType": "image/png",
      "sha256": "<hex sha256 of the decoded image>"
    },
    "typography": { "family": "satoshi" }
  },
  "journeys": {
    "myProducts": true,
    "quoteDecisions": true,
    "registration": true,
    "serviceProgress": true,
    "transfer": true
  },
  "navigation": ["inventory", "products", "activity", "settings"],
  "release": {
    "approvedContentHash": "sha256:<hex>",
    "configVersion": "1.0.0",
    "studioVersionRef": "studio@2026.10.1"
  },
  "schema": "dual-wallet-host-configuration-v1"
}
```

| Field                                    | Rule                                                                                                                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                                 | Exactly `dual-wallet-host-configuration-v1`.                                                                                                                                                                                                    |
| `brand.id`                               | `^[a-z0-9][a-z0-9-]{1,62}$`.                                                                                                                                                                                                                    |
| `brand.name`, `shortName`, `description` | Display text of at most 40, 16 and 160 characters: non-empty, trimmed, no control characters, no `<` or `>`.                                                                                                                                    |
| `entrance.origin`                        | An exact origin (no path, credentials or wildcard), `https`; `http` only for loopback outside production. Must equal the origin of `NEXT_PUBLIC_APP_URL`.                                                                                       |
| `entrance.organizationId`                | A Dual organisation ObjectID, `^[0-9a-f]{24}$`.                                                                                                                                                                                                 |
| `identity.logo`                          | `image/png` or `image/webp` only (never SVG); magic bytes must match (PNG signature and IHDR; RIFF/WEBP of exactly its size); canonical base64; at most 32 KiB decoded; `sha256` of exactly the decoded bytes.                                  |
| `identity.colours`                       | The eleven keys above, each lowercase `#rrggbb`, passing every [contrast rule](#contrast).                                                                                                                                                      |
| `identity.typography.family`             | One of the bundled families: `satoshi` (the engine's own files in `public/fonts`), `system-sans`, `system-serif`, `system-rounded` (system stacks). No remote font.                                                                             |
| `home.headline`, `home.introduction`     | Display text of at most 80 and 280 characters.                                                                                                                                                                                                  |
| `home.primaryJourney`                    | An enabled journey.                                                                                                                                                                                                                             |
| `navigation`                             | An ordered, unique subset of `inventory`, `products`, `activity`, `settings` (labels are the engine's). `products` needs `journeys.myProducts`.                                                                                                 |
| `journeys`                               | The five booleans, plus the optional `tickets` boolean (absent is false; see [Tickets](#tickets-opt-in-read-only-p42)). `quoteDecisions` needs `serviceProgress`. Every enabled journey must be [backed](#journeys) by one of the host's faces. |
| `faces`                                  | 1-32 unique face slugs, each a valid binding in `PRODUCT_FACE_APPLICATIONS`. Any other binding in that registry is not this host's.                                                                                                             |
| `release.configVersion`                  | Semver.                                                                                                                                                                                                                                         |
| `release.approvedContentHash`            | `sha256:` + hex sha256 of the canonical JSON of the document **without** `release`: the hash Studio's owner approved.                                                                                                                           |
| `release.studioVersionRef`               | `^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$`.                                                                                                                                                                                                       |

The parser is `api/host-configuration.ts` (`evaluateHostConfiguration`), the
contract constants are in `app/_domain/wallet-host.ts`, and the exhaustive
cases are in `api/host-configuration.test.ts`. Studio's validator must agree
with it on a shared fixture.

### Contrast

A host renders one validated palette in both theme states, so the palette must
keep the shell at WCAG 2.2 AA. The contract's listed pairs are first; the rest
are the checks the engine's own light palette passes
(`app/_components/design-system/contrast.test.ts`) for the places the shell
uses those tokens:

| Rule                                                                                      | Minimum |
| ----------------------------------------------------------------------------------------- | ------- |
| `ink` on `surface`; `onActionPrimary` on `actionPrimary`; `actionPrimary` on `surface`    | 4.5     |
| `onActionPrimary` on `actionPrimaryHover`                                                 | 4.5     |
| `ink` on `surfaceSubtle` and on `brandSoft`                                               | 4.5     |
| `muted` on `surface` and on `surfaceSubtle`                                               | 4.5     |
| `brandStrong` on `surface`, `surfaceSubtle` and `brandSoft` (accent text and focus rings) | 4.5     |
| the engine's `--border-strong` (`#799094`) on `surface`                                   | 3       |
| the engine's success, warning and danger chips on their tints of `surface`                | 4.5     |
| `onActionPrimary` on the avatar gradient stop (`actionPrimary` mixed 78% with `ink`)      | 4.5     |

## Identity

- **Metadata**: the brand's name as the title and title template, its
  description, its short name as the application name, and the pinned logo as
  icon and share image. Nothing of the generic wallet's (title, favicon, share
  image) is referenced.
- **Tokens**: the root layout renders the colours as the existing semantic
  tokens (`--brand`, `--brand-strong`, `--brand-soft`, `--ink`, `--muted`,
  `--action-primary`, `--action-primary-hover`, `--on-action-primary`,
  `--surface`, `--surface-subtle`, `--border`, and `--content-accent` and
  `--surface-raised` derived from them) with the engine's fixed light status
  values, plus the selected font stack. `hostTokenCss` re-checks every value;
  no configured text ever reaches CSS or markup, so the CSP is unchanged. The
  host offers no theme switch.
- `html[data-wallet-host]` scopes the engine rules that replace the generic
  wallet's fixed colours (the dark auth story, the primary button glow) with
  those tokens. The generic wallet never matches them.
- **Logo**: `GET /api/host/logo/<sha256>` serves exactly the pinned bytes with
  their media type, `Cache-Control: public, max-age=31536000, immutable`, an
  `ETag` of the hash and `nosniff`. Any other hash is 404.
- **Sign-in pages** tell the host's headline and introduction beside its name
  and logo.

## Home and navigation

- `/` renders the host's home: headline, introduction, the primary journey
  and every other enabled journey, sign-in links when signed out and the
  configured navigation when signed in. A signed-in visitor with no return
  path lands there.
- The shell shows exactly the configured navigation entries, in order.
- A journey's link is its start task in the first of the host's faces that
  backs it: registration `/register`, My products `/products`, service
  progress and quote decisions `/service`, transfer the face home.

## Journeys

| Journey           | Face routes (contract task paths)                                              | BFF routes and operations                                                                                             | Backed by a face with                               |
| ----------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `registration`    | `/register…`; the handover entry                                               | `registration.*`; journal kinds `registration` and `settle`; `settle-proposal`; `units/<id>`; a handover ticket       | any binding                                         |
| `myProducts`      | `/products…`; the wallet's programme list                                      | `products.private.read`                                                                                               | any binding                                         |
| `serviceProgress` | `/service…`                                                                    | `cases.list`, `case.read`, `case.open`, `case.evidence.submit`, `case.information.provide`                            | a linked `claims-warranty` runtime                  |
| `quoteDecisions`  | (inside `/service`)                                                            | `case.quote.approve`, `case.quote.decline`                                                                            | a linked `claims-warranty` runtime                  |
| `tickets`         | wallet-native `/products/<slug>/tickets` and `/tickets/<object id>` (no frame) | `GET /api/faces/<slug>/tickets` and `/tickets/<object id>`, read-only                                                 | a binding with `tickets` rules                      |
| `transfer`        | `/accept…`; `/products/<id>/transfer…`; the handover entry                     | `transfer.*`; journal kind `transfer`; `transfer-proposal`, `transfer-progress`, `accept-offer`; an acceptance ticket | a `transferRequest` template and `handover.enabled` |

The face home, `/support` and `/ended` need no journey; the context read,
selection and the journal list are shared by all of them. The list's
`retained` entries (transfer steps this same wallet sent from another launch
of the same face and programme) are listed on every host, to the wallet's own
page only; reading or moving one (`transfer-progress`, by its id or its offer)
is the transfer journey's and is refused on a host without it.

### Tickets (opt-in, read-only; P4.2)

- `journeys.tickets` is the one optional journey key. An omitted key is
  `false`, so every configuration written before it keeps its canonical bytes,
  hash and readback; the readback reports `tickets` only for a host that
  enabled it. The generic wallet never serves Tickets. Enabling it requires a
  face of the host whose binding declares `tickets` rules
  ([registry](./external-face-integration.md)).
- A ticket is a Dual object the signed-in account currently owns, issued by the
  host's entrance organisation, from one of the programme's templates. The list
  reads `listObjects` filtered by owner and template (never organisation-wide)
  and re-checks every object; the detail re-reads the object with the
  session's own credential and answers the same `not_found` for another
  holder's, client's or programme's object.
- Status is honest: `issued` and `pending` require the original issue
  operation identity recorded on the object at the binding's path; an
  unrecognised state, or a missing issue operation, is `unconfirmed`, never
  issued. Admission is a constant "not available" until P4.3, whatever the
  object says. A failed read or a host without ticket rules is shown as
  unavailable, never as an empty list.
- The pages are protected: a signed-out visit signs in and returns to the exact
  list or ticket.

### Enforcement is on the server

- **Pages**: the request proxy answers a disabled journey's pages, another
  face's pages and any task outside the contract's routes with the not-found
  page (404) before any guard, redirect or cookie. The products and task pages
  repeat the check.
- **BFF**: `api/host-journey-guard.ts` classifies each face request by the
  route that serves it, never by a path pattern: every face route except the
  assertion and journal routes passes its own identity to
  `resolveFaceRequest`, and those two are recognised only at their exact
  canonical path for the slug they serve, then by the operation or journal
  entry the request carries. A face's holder-signed step through
  `/api/backend` (contract r18) is classified by its bound journal entry: a
  settle step is registration's, a transfer step is transfer's.
  `resolveFaceRequest` refuses, with 403 `capability_not_granted` and before
  any route logic runs, every request of a disabled journey **and every
  request it cannot classify** (an unnamed path, an operation or journal step
  of no journey): it fails closed. Nothing is journaled, read from a runtime,
  minted or executed for it. The handover entry keeps no ticket of a disabled
  journey and the context read hands none over.
- **Paths**: the request proxy answers an entry-link prefix in front of
  `/api` (`/<organisation>/api/...`) with 404 on a branded host instead of
  rewriting it, so no route handler is reached under a path other than its
  own. The generic wallet keeps that rewrite unchanged.
- **Registry**: a configured host's face registry holds only its own faces;
  any other binding is `unknown_application`.
- **Native transfer**: a host without the transfer journey offers no native
  transfer either. The object actions offer no Transfer control (nor run a
  face-requested one), and the request proxy refuses (403
  `capability_not_granted`) every write to the backend proxy whose body names
  Dual's `transfer` action, in any spelling a case-folding JSON decoder would
  accept and at any spelling of the path routing would serve as
  `/api/backend`, before the backend route runs: nothing is prepared,
  executed or sent to Dual. A body it cannot read as JSON is refused too.
  The backend route repeats this decision on exactly the bytes it forwards.
  Other actions, and every request on a host with transfer enabled or on the
  generic wallet, are unchanged.

A face may still show its own screens for a disabled journey inside its
frame; every operation behind them is refused. Studio publishes faces whose
routes match the host's journeys.

## Entrance and isolation

- Tenant resolution is exactly `entrance.organizationId` on exactly the
  entrance host (its default port optional): no wildcard, no
  `DEFAULT_ORGANIZATION_ID`, no entry-link organisation, no other host
  mapping. Sign-in is made against that organisation and refused when the
  access token names another; every session stays bound to the organisation
  and host, so a session, journal, selection or assertion of another
  organisation, host or session is refused by the existing checks (journals
  are sealed to the session, launch, face and programme).
- Any other address answers `421` (pages: a neutral notice; BFF:
  `host_misdirected`). Entry links, mail links and the remembered organisation
  cookie are honoured only for the host's own organisation.
- Cookies stay host-only. A brand host adds no cookie and no store.

## Fail closed

When the configuration is present but invalid, pin-mismatched or not the one
the build rendered (configuration or face registry):

- every page is a neutral `503` "This wallet is being set up" (system colours
  and fonts; no brand, no generic wallet identity);
- every session, backend and face route answers `503 host_unavailable`, and
  the root layout, face BFF, handover entry, logo and public display proxy
  refuse on their own;
- tenant resolution and the face registry are empty, so nothing falls back to
  the generic wallet or another organisation;
- the server log names the problem (for example `pin_mismatch`), never the
  configuration's content;
- the readback reports `status: "invalid"`.

## Readback

`GET /api/host/configuration` is public, uncached and secret-free, on any
address and in every state:

```json
{
  "schema": "dual-wallet-host-configuration-v1",
  "brandId": "morrow-home",
  "organizationId": "a1a1a1a1a1a1a1a1a1a1a1a1",
  "origin": "https://wallet.morrow.example",
  "configurationSha256": "<the pin of the configuration served>",
  "configVersion": "1.0.0",
  "engine": {
    "version": "0.1.0",
    "commit": "<the built engine commit or null>"
  },
  "journeys": {
    "registration": true,
    "myProducts": true,
    "serviceProgress": true,
    "quoteDecisions": true,
    "transfer": true
  },
  "faces": ["morrow-home"],
  "status": "active"
}
```

`engine.commit` is the commit the build recorded from the source it built:
the HEAD of a clean git checkout of exactly the built directory (a local or
prebuilt build, `vercel build` then `vercel deploy --prebuilt`), else the
platform's build-time `VERCEL_GIT_COMMIT_SHA` (a Git-integration build, which
has no checkout). A dirty checkout records nothing. With no recorded commit it
is the runtime `VERCEL_GIT_COMMIT_SHA`, which a CLI or prebuilt deployment of
a project not linked to the repository does not get, else `null`. Nothing set on a deployment supplies
it. `.vercel` is ignored, so the CLI's own folder never makes a checkout dirty.

`invalid` carries only `schema`, `engine`, `status` and the
`configurationSha256` of the configuration actually present (null when none);
`absent` carries only `schema`, `engine` and `status`. Studio and Root compare
it with the approved configuration and the engine release.

## Lifecycle

- **Studio** drafts, validates (the same schema), approves the exact
  `approvedContentHash`, emits the canonical document and its pin with the
  host's deployment entry (project, domain, non-secret values, required
  secret names, engine commit), and compares the readback with what it
  approved. It never handles secrets.
- **Root** provisions the host (project, domain, secrets), deploys the engine
  commit with the emitted values, and accepts it live.
- **Upgrade**: every host is redeployed from the same new engine commit; the
  readback shows `engine.commit` per host. Records stay continuous because the
  wallet stores none and each host keeps its origin and `SESSION_SECRET`.
- **Rollback**: redeploy the previous engine commit with the previous approved
  configuration (a platform rollback restores both, since the configuration is
  part of the build).

## Limits

- Face bindings carry no organisation; a face belongs to a host by being
  named in its configuration and deployed in its registry, and the session's
  organisation binds every request.
- The whole configuration, logo included, is one environment value. Keep
  logos small: the platform limits the total size of a deployment's
  environment.

# External-face integration in the wallet

This document is the implementation guide for changing external-face behavior
inside Dual Wallet. It records the shipped host behavior, security boundary,
file ownership, tests, and cross-repository release impact.

For the wire protocol and face-authoring contract, use the canonical documents
in the sibling `external-faces` workspace:

- `external-faces/docs/bridge-protocol-v1.md`
- `external-faces/docs/security.md`
- `external-faces/docs/face-authoring-guide.md`
- `external-faces/docs/hosting-and-deployment.md`

The wallet code is authoritative for what the host actually grants. A face
manifest or publisher config cannot grant itself a capability.

## Product boundary

The wallet is a generic wallet and safe object renderer. It owns:

- public object routes and authenticated inventory;
- selection of `card`, `detail`, and `share` display variants;
- standard metadata fallback when no usable display exists;
- iframe sandboxing and aspect-ratio containers;
- the authenticated external-face bridge host;
- The wallet session, object binding, native confirmation UI, signing, action
  execution, cache invalidation, and activity rendering.

An external face owns presentation inside its iframe. It never receives the
wallet JWT, refresh token, cookie, passkey material, EOA signature, or generic
backend access. Workflows that need broad authenticated APIs belong in a
dedicated top-level application with its own BFF and host-only session; see
`docs/dedicated-applications.md`.

## Display resolution

`api-v3` resolves a source-free `ObjectDisplay` from the selected
`FaceView`. The wallet adapts that response in `app/_adapters/inventory.ts` and
renders it in `app/_components/inventory/object-visual.tsx`.

The normal selection is:

| Surface                   | Requested variant                       | Interaction                        | Authenticated bridge                                  |
| ------------------------- | --------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| Public object page        | `card` or resolved public route variant | Display-specific                   | Never                                                 |
| Inventory grid/list card  | `card`                                  | Disabled on the card link          | Minimized current-object context only when registered |
| Authenticated object page | `detail`                                | Allowed when `interactive` is true | Registered detail capabilities                        |
| Share URL                 | `share` where requested by the API      | Public-only                        | Never                                                 |

If `detail` or `default` is absent, the object page uses the standard metadata
face. If no display is usable at all, the wallet renders name, description,
category, object ID, and the metadata image when present. A missing face must
never produce an empty object page.

The supported presentation kinds are:

- image: rendered by `next/image`;
- inline document: fetched through the fixed same-origin public-display route,
  prefixed with a restrictive CSP, and rendered in an opaque, script-free
  `srcDoc` iframe;
- external document: loaded directly from its HTTPS URL in a sandboxed iframe;
- standard metadata fallback.

Do not turn inline documents into script-capable documents. Do not use
`dangerouslySetInnerHTML` for face or object data.

## URL-backed faces and iframe policy

An external document currently uses:

```text
sandbox="allow-forms allow-same-origin allow-scripts"
referrerPolicy="no-referrer"
```

There is deliberately no popup, download, top-navigation, parent-DOM, or
wallet-session permission. The remote application must allow framing by the
wallet origin through its CSP. It runs on its own origin and is responsible for
its own content security.

`api-v3` resolves `object_id` and `variant` into the external view URL. On an
authenticated route, the wallet adds `dual_bridge=1` only when the URL matches a
registered application binding. The query flag is a mode hint, not authority;
the bridge still requires the exact-origin `MessageChannel` handshake and
application identity check.

`FaceView.aspect_ratio` is validated as a positive integer ratio such as
`5/8` or `16/10`, adapted to `ObjectPresentation.aspectRatio`, and applied to
the iframe container. The embedded application must also be responsive inside
that container. Test both narrow phones and the intended desktop/card ratio.

## Public data flow

Public pages use only the public projection:

```text
GET /public/objects?id=<id>&limit=1&include=display&display_variant=<variant>
GET /public/objects/<id>/display/<variant>
GET /public/objects/<id>/attributes?limit<=25&cursor=<cursor>
```

wallet's inline display proxy is
`/api/public/objects/[objectId]/display/[variant]`. It validates the fixed path,
caps the response, returns text rather than trusted HTML, and never attaches a
wallet session.

Public pages must not initialize the bridge or fall back to authenticated
object/attribute endpoints. An object ID is an identifier, not authorization.

## Authenticated bridge flow

The host is split by responsibility:

```text
app/_lib/external-face-bridge/
  core/          application binding, context, envelopes, channel, limits
  capabilities/  named operations and injected wallet handlers
  index.ts       public host exports
```

`app/_lib/external-face-bridge.ts` is the compatibility facade. Do not add a
second `postMessage` protocol.

The handshake is:

1. The wallet verifies the iframe URL against its build-time application registry.
2. The wallet creates a random channel ID and transfers exactly one `MessagePort`
   to the exact target origin.
3. The child answers with `dual.face.ready`, protocol version, channel ID, and
   application `{id, version}`.
4. The wallet verifies ID and semantic major, then sends the bound context through
   the private port.
5. All subsequent requests and events use that port, strict envelopes, unique
   request IDs, size limits, and rate limits.

Current host limits in `core/protocol.ts` are:

| Limit                  | Value                     |
| ---------------------- | ------------------------- |
| Ready timeout          | 5 seconds                 |
| Request size           | 64 KiB                    |
| Response size          | 512 KiB                   |
| Requests               | 30 per minute per channel |
| Remembered request IDs | 2,048                     |

The normalized context contains the selected object projection, selected view
config, locale, theme, variant, and granted operation names. Detail contexts
may also contain the available standard action names. Card contexts contain no
owner, custom data, system data, content/state hashes, or actions. Every
context omits generated DTO internals, credentials, signing material, and raw
action payloads. Revision hashes used for host-side change detection remain
internal and are never serialized to a card iframe.

## Capability matrix

The protocol-v1 operation names are:

- `bridge.ping`
- `object.current.read`
- `object.changes.subscribe`
- `object.changes.unsubscribe`
- `object.attributes.read`
- `object.action.request`
- `viewer.details.open`

Core current-object and subscription operations are composed by the host.
Additional operations are advertised only when the rendering component injects
the corresponding handler.

Inventory cards expose only `bridge.ping` and the minimized
`object.current.read`; they do not expose change subscriptions because the v1
event envelope contains a content hash. They also do not inject
private-attribute, action, or wallet-UI handlers. The authenticated detail
component injects:

- `viewer.details.open` to open the native details modal;
- `object.attributes.read` to load attributes for the already-bound object;
- `object.action.request` only when the wallet can run the native action flow.

`object.attributes.read` accepts no object ID. The handler calls the generated
SDK for the bound object and returns the minimized attribute projection.

`object.action.request` is untrusted intent. The child supplies only a supported
action name and schema-checked suggested defaults. The wallet:

1. refetches fresh object/action availability;
2. rejects child-supplied object, wallet, controller, organization, endpoint, or
   unknown input fields;
3. opens native confirmation UI;
4. executes through the existing email, passkey, or EOA path;
5. returns only `{status: "completed", action_id}`.

Never add `fetch`, `proxy`, `getToken`, `getCookie`, `executeAction`, or an
equivalent generic authority operation.

## Application registry configuration

The production default is:

```text
NEXT_PUBLIC_EXTERNAL_FACE_BRIDGE_ORIGINS=https://faces.dual.network
NEXT_PUBLIC_EXTERNAL_FACE_BRIDGE_APPLICATIONS=dual.dpp@1=https://faces.dual.network/dpp/v1/
```

`NEXT_PUBLIC_EXTERNAL_FACE_BRIDGE_ORIGINS` is the coarse exact-origin gate.
`NEXT_PUBLIC_EXTERNAL_FACE_BRIDGE_APPLICATIONS` is the authoritative
application-ID, semantic-major, origin, and path-prefix binding. Origin alone
is insufficient.

Both values are public build-time inputs embedded by Next.js. Changing them
requires rebuilding and redeploying the wallet. A trailing slash is required on the
registered path. Multiple bindings are comma-separated.

Local non-production builds additionally allow the reviewed bridge fixture at
port 4100. Do not add production wildcard origins or broad path prefixes.

## Important files

| Concern                                   | File or directory                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| API response adaptation and fallback      | `app/_adapters/inventory.ts`                                                    |
| Image/document/external iframe renderer   | `app/_components/inventory/object-visual.tsx`                                   |
| Inventory card grants                     | `app/_components/inventory/object-card.tsx`                                     |
| Detail grants, modals, and action handoff | `app/_components/inventory/object-detail.tsx`                                   |
| Attribute and action host services        | `app/_services/external-face.client.ts`                                         |
| Application/path/major registry           | `app/_lib/external-face-bridge/core/application.ts`                             |
| Object/config/action context              | `app/_lib/external-face-bridge/core/context.ts`                                 |
| MessageChannel host and limits            | `app/_lib/external-face-bridge/core/transport.ts`                               |
| Capability contracts                      | `app/_lib/external-face-bridge/capabilities/`                                   |
| Public inline-display proxy               | `app/api/public/objects/[objectId]/display/[variant]/route.ts`                  |
| Unit/integration coverage                 | `app/_lib/external-face-bridge.test.ts`, `app/_components/inventory/*.test.tsx` |
| Cross-origin E2E                          | `e2e/app.spec.ts`, `e2e/support.ts`                                             |
| Product application registry and BFF      | `api/product-face-*.ts`, `api/face-*.ts`, `app/api/faces/[slug]/`               |
| Product application bridge                | `app/_lib/external-face-bridge/core/product-*.ts`, `capabilities/programme*.ts` |
| Product application host and dialog       | `app/_components/products/`, `app/_hooks/use-product-face-host.ts`              |
| Product application E2E                   | `e2e/product-face.spec.ts`, `e2e/product-face-fixture.mjs`                      |
| Deployment registry inputs                | `.env.example`, `Makefile`, `Dockerfile`                                        |
| Shared product-face contract              | `contracts/dual-product-face-v1.json`                                           |

## Product application host (`dual-product-face-v1`)

A programme's reviewed product application ("product face") runs full-size
inside the signed-in wallet at `/products/<slug>/<task path>`. The shared
contract is `contracts/dual-product-face-v1.json` (revision 4); this section is
what the wallet implements of it. It reuses the v1 envelope, handshake and
limits above: there is no second `postMessage` protocol and no generic
fetch, proxy, token or execute operation.

### Routes and entry

- `/products` lists the programmes in the server-only registry. A programme
  entry has no selected or owned object.
- `/products/[slug]/[[...task]]`: `app/(authorized)/products/[slug]/layout.tsx`
  (Server Component) refuses an unknown slug and renders the client
  `ProductFaceHost`; the empty `[[...task]]` page only validates the task path.
  The host lives in the layout so task changes keep the same frame.
- The identity bar names the programme and publisher from the registry, never
  from the face, with Back to `/products`. At phone widths (760 px and below)
  it is one slim row: Back, the programme name (ellipsized, full name in its
  title) and a publisher disclosure button (`aria-expanded`, Escape closes);
  the frame takes the rest of the viewport. At 390×844 the frame starts 53 px
  below the 68 px wallet bar (114.5 px before) and runs to the bottom edge;
  there is no horizontal overflow at 320 or 390 px.
- The frame is `sandbox="allow-scripts allow-same-origin allow-forms"`,
  `allow=""`, `referrerPolicy="no-referrer"`: no popups, downloads, top
  navigation or device permissions.
- Task paths follow `contract.taskPath`. `navigation.task.update` pushes a new
  path and replaces the same path; Back/Forward and links send
  `navigation.task.restore`; a reload hands the task to the face in
  `initialize.context.task`. A path segment naming a product is a hint only.
- A signed-out visit to any protected route goes to `/login?next=<path+query>`.
  `next` must be a same-origin relative path to a protected route (single
  leading `/`, no `//`, backslash, control character or fragment, at most 512
  characters, unchanged by URL normalization). Sign-in, an already signed-in
  auth entry and verification return there; anything else falls back to
  `/inventory`. An explicit sign-out never carries a return path.

### Registry (G5)

There is no backend face-application registry, so the deployment configures a
server-only JSON array in `PRODUCT_FACE_APPLICATIONS`
(`api/product-face-binding.ts`, `api/product-face-registry.ts`). Each entry has
exactly these keys:

| Key                      | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`                   | `^[a-z0-9][a-z0-9-]{1,62}$`, unique                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `applicationId`          | `^[a-z0-9][a-z0-9._-]{1,127}$`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `version`                | exact semver (no range, no build metadata)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `publisher`              | `^[a-z0-9][a-z0-9._-]{1,63}$`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `programmeId`            | `^[a-z0-9][a-z0-9._-]{1,63}$`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `programmeName`          | plain display text, at most 80 characters                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `origin`                 | exact `https` origin with a DNS host name; loopback `http` only outside production                                                                                                                                                                                                                                                                                                                                                                                                           |
| `path`                   | exactly `/face/<applicationId>/<version>/<64 hex of artifactHash>/`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `artifactHash`           | `sha256:<64 lowercase hex>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `templateIds`            | 1–32 unique lowercase 24-hex Dual template IDs                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `projectionFields`       | subset of `recordId,title,serialNumber,model,manufacturer,state`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `canonicalRegistration`  | `{stateField, lifecycleTargetField, settledStates, unconfirmedStates, endedStates}`, disjoint state sets                                                                                                                                                                                                                                                                                                                                                                                     |
| `settle` (optional)      | `{action, alias?, inputTemplate, fromStates, targetStates, preserveUnlisted}` or Studio's `{action, inputPath, leaves, fromStates, targetStates, preserveUnlisted}`; see G6 below                                                                                                                                                                                                                                                                                                            |
| `transferRequest` (opt.) | G8 request step, settle shaped: `{action: "update", inputPath, leaves, fromStates, targetStates, preserveUnlisted}` (fromStates settled, targetStates unconfirmed, no alias); absent: `programme.product.transfer.sign` is `capability_not_granted`                                                                                                                                                                                                                                          |
| `linkedRuntimes` (opt.)  | at most one `{purpose: "claims-warranty", applicationId, origin, instanceId}`: the Warranty runtime connected to this programme (r10)                                                                                                                                                                                                                                                                                                                                                        |
| `tickets` (opt.)         | P4.2 read-only Tickets projection: `{fields: {event, issueOperation, state, startsAt?, venue?, entryClass?, entryGuidance?}, states: {pending, issued, ended}}`. `fields` are distinct dotted custom paths on the programme's objects; the three state lists are disjoint and `issued` is non-empty. Absent: the face backs no Tickets journey and the wallet serves none (403 `capability_not_granted`). It grants a face nothing: Tickets are wallet-native pages, not a bridge capability |
| `handover` (opt.)        | exactly `{enabled: boolean}`; absent is off. Lets face-enabled handover links enter this face (r14)                                                                                                                                                                                                                                                                                                                                                                                          |

Invalid entries are dropped, a slug configured twice drops every entry using
it, and malformed JSON is an empty registry. A linked runtime is as strict:
exactly its four keys, an exact origin under the same `https`/loopback rule,
`instanceId` matching `^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$`, an application
other than the face itself, one per purpose; any invalid linked runtime drops
the whole entry. Linked runtimes stay server-side: they are not frame origins
and are not in the browser-safe binding. `next.config.ts` derives the CSP
`frame-src` additions from the same parser, so they are exactly the registry
origins with no wildcard. The CSP is computed at build time: a new product
origin needs a rebuild, and an origin the build did not see is blocked.

### Server BFF

Every route resolves the binding from the slug, requires the launch ID header
and the active session (terminal 401 clears the session and every launch
journal cookie), answers `private, no-store`, and checks the mutation origin on
POST.

| Route                                            | Purpose                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/faces/[slug]/context`                  | verifies the pinned artifact, resets the server-side selection, returns the browser-safe binding and frame URL                                                      |
| `GET /api/faces/[slug]/units/[objectId]`         | canonical facts of an unowned unit from the public projection; template must be in the programme                                                                    |
| `POST /api/faces/[slug]/selection`               | re-reads the object with the session credential; owned by the session wallet and in the programme, else `not_owned`/`not_in_programme`; issues a fresh `context_id` |
| `GET/POST /api/faces/[slug]/operations`          | lists or moves the launch's journal entries (`begin`, `confirm`, `cancel`, `submit`, `record_action`); a settle `submit` reserves at the runtime first (r8/r11)     |
| `GET /api/faces/[slug]/operations/[operationId]` | read-only status from the journal and the wallet's canonical readback; never retries, mints or executes                                                             |
| `POST /api/faces/[slug]/assertions`              | mints one assertion for one exact runtime request                                                                                                                   |
| `POST /api/faces/[slug]/settle-proposal`         | trusted runtime read of the settle proposal (G6)                                                                                                                    |
| `POST /api/faces/[slug]/handover`                | signed-out allowed, no launch header: stores a face handover ticket in the pre-auth cookie for a handover-enabled slug (r14)                                        |

**Artifact verification.** The context route fetches `manifest.json` and
`index.html` from the pinned path without credentials, redirects refused,
with a 64 KiB/256 KiB cap and a 5 s timeout. It requires the artifact hash
recomputed from `manifest.files` — sha256 over the sorted
`<name>\t<sha256:hex>\n` lines, the emitter's algorithm — to equal the binding,
`sha256(index.html)` to equal `manifest.files["index.html"]`, and every script
and stylesheet in `index.html` to be an artifact file whose SRI equals the
manifest hash (`face.js` and `face.css` required). Any mismatch answers
`artifact_mismatch` and the browser renders no frame. The ready message's
`artifact` is checked as well but is not relied on. Residual: the browser
fetches the frame document itself, which has no SRI; trust rests on the
reviewed, immutable, content-addressed deployment.

**Trusted runtime reads.** Facts the host shows in its own confirmations come
from the bound runtime, not the face: the BFF calls
`POST <origin>/api/product-face/v1/operations` server to server with a
host-minted assertion, for `registration.settle.propose` and `case.read`
only, with a 64 KiB response cap, an 8 s timeout and the routing header
`x-tig-product-face-application: <applicationId>`. Only a narrow projection
(proposal or quote) reaches the browser. Since contract r10 `case.read` goes to
the linked Warranty runtime's origin with that runtime's application ID in the
routing header, not to the face's own runtime.

### Wallet assertion (G1 seam)

`api/face-assertion.ts` signs a compact JWS, `alg` EdDSA (Ed25519), `typ`
`dual-face-assertion+jwt`, `kid` `FACE_ASSERTION_KEY_ID`, with exactly the
claims `iss` (the exact tenant origin; a present `Origin` must equal it),
`aud` (`<applicationId>@<origin>`), `app_id`, `app_version`, `artifact`,
`publisher`, `programme`, `origin`, `sub` (wallet ID), `holder` (the session
wallet's account address, read server-side), `operation`, `op_id`, `target`,
`request_hash`, `sid_hash` (hash of a random session ID sealed into the session
cookie; tokens and the sealed cookie rotate, the ID does not), `iat`,
`exp = iat + 60` and a fresh `jti`. Nothing from the browser or face names the
holder, wallet or subject; such a key is refused.

**Case operations (contract r10).** For `case.*` and `cases.list` the `aud` is
the linked Warranty runtime, `<linked applicationId>@<linked origin>`; every
other claim stays the same, `artifact` included (the face's artifact). The
face still sends the request to its own runtime, which relays it unchanged;
the Warranty runtime verifies the assertion and the holder's ownership itself.
Without a linked runtime the BFF mints nothing for a case operation and
answers `409 case_runtime_not_linked`. `cases.list` is treated as a case
operation because it lists the holder's cases, which live in the Warranty
runtime; the contract names only `case.*`.

Before every mint the server re-checks the session, the wallet, the journal
and, for product-scoped operations, that the server-side selection still
names this `context_id` and object. After logout, expiry, an account change or
a product switch nothing is minted for the old context. `registration.submit`
needs a `confirmed` journal entry for that operation and unit and moves it to
`assertion_issued` in the same response. Since contract r6 its `request_hash`
is the face's hash over its entire exact runtime registrations body (assertion
excluded): the host checks its format, binds it into the journal entry at
confirmation, and mints it unchanged; any other hash is refused, and the
runtime recomputes it over the body it receives. A case write needs a
`confirmed` entry whose target (and, for a quote, the host-read quote) equals
the request. Every other runtime operation's `request_hash` is likewise the
face's hash of its full canonical body.

`FACE_ASSERTION_SIGNING_KEY` (PKCS8 PEM, or base64 of it) and
`FACE_ASSERTION_KEY_ID` are server-only. Absent or invalid, every mint fails
closed with `503 face_assertion_unprovisioned`. Provisioning is outside this
repository (G1): the runtime needs the public key in
`TIG_PRODUCT_FACE_WALLET_ASSERTION_KEYS` and the exact wallet tenant origins in
`TIG_PRODUCT_FACE_WALLET_ISSUERS`.

**Honest residual.** There is no runtime face session: every runtime
operation needs its own assertion. Each minted but unconsumed assertion stays
usable for its one exact request (operation, target and `request_hash`) until
first use or expiry, at most 60 seconds; the wallet cannot revoke it at the
runtime without a revocation or introspection contract. The journal caps
outstanding unexpired assertions per launch at 10, a client-side bound that
is not a runtime guarantee.

### Operation journal (per launch)

Each launch (one frame) of a face has its own journal. The host generates a
random launch ID when it opens the frame and sends it on every BFF call
(`x-dual-face-launch`); a call without one is refused with `launch_required`.
The journal is a sealed (AES-256-GCM, additional data naming the purpose and
the launch ID), host-only, `HttpOnly`, `SameSite=Strict` cookie per launch
(`__Host-dual_face_launch_<launchId>` in production, a 24-hour lifetime),
bound to the session ID hash, the wallet ID, the face and the launch; any
other session, wallet, face or launch reads it as empty, and two tabs never
overwrite each other. A launch cookie may hold unresolved evidence that
authority left the wallet: (a) a registration whose assertion was issued and
is not settled, (b) a transfer step that was sent (`submitted`) and is not
settled, or (c) a runtime write (`kind: "runtime"`, `assertion_issued`: a
Warranty & Service write, a transfer offer or its cancellation), whose
outcome the wallet does not learn. At most four launch cookies are kept per
browser: this session's, and an earlier session's of the same wallet while it
still holds such evidence (or a registration whose assertion was issued and
that has settled since). Such a cookie is kept as it was: a later write never
names it, so it is neither re-sealed nor given a new expiry (a transfer
progress read of that step writes the reading launch's journal and keeps the
record it reads). Within the four, a launch of this wallet holding unresolved
evidence, (a), (b) or (c), is never dropped (no unknown eviction: that cookie
may be the wallet's only known correlation of the operation). A new launch
that could be given a cookie only by dropping one runs **read-only** instead
(`launchCapacity` in `api/face-journal.ts`): its context opens, the host's
own reads (programme products, units, histories, an operation's status, the
runtime's recovery listing and acknowledgement) answer, nothing of it is
persisted (no launch cookie is written and no other launch is touched), and
every request that would have to journal (a selection, a `begin` or other
journal transition, an assertion, a transfer proposal or acceptance) is
refused `launch_capacity` (409) before anything is read, minted, journaled or
sent. The face hears the refusal; the host, in its own UI, says the launch is
read-only and offers no restart (a new launch would be read-only too). Such a
launch can do what it could not as soon as an earlier launch's evidence
resolves, is confirmed as below, or expires. Face-driven runtime reads need
an assertion and so a launch slot; they are not available read-only.

A launch holding only (c) becomes expendable in exactly one way: when the
exact runtime's durable, actor-scoped discovery has actually named the
write's record, the entry is marked `discoverable` (journal transition
`discover`) and that launch ranks below (a), (b) and unconfirmed (c), dropped
only after every finished, unfinished and empty launch. The confirmation is
the discovery itself (contract r20 §2): a complete, validated, echo-bound
`recovery.list` scan of this actor, from the runtime that serves the
operation, naming exactly that record (same operation id, operation, object
and case, listed by one runtime only), read by the launch that holds the
write. The listing itself writes nothing: for each such record it returns a
sealed, short-lived discovery ticket (bound to the session, wallet, face,
programme and launch) that the host hands straight back
(`POST /api/faces/[slug]/recovery/discovered`), and the mark is applied
against the journal as it is then, never from the listing's own earlier
read, so a write journaled while the scan ran is never overwritten. In the
shipped host that listing runs when a launch opens (before it holds
anything) and on **Continue checking**, so a launch's own held writes are
confirmed only when that same launch lists again; a launch whose frame is
gone stays undroppable for its own 24 hours on every runtime. A scan the
wallet found violated, or one the runtime calls incomplete, yields no ticket
even for the records it named. Nothing else marks anything: a
`write_applied` answer settles the entry instead, a `write_refused` answer
leaves it held and unmarked, and a `409 write_outcome_unknown` is never read
as bound (the wallet validates no echo on a refusal; whether refusals must
carry the §0 echo is open with Root, see the evidence record), so it proves
nothing about any record. A planned or presumed recovery never marks
anything; a runtime without r20 never confirms, so against it every (c)
launch stays undroppable for its own 24 hours. Other launches go first, the
oldest within a
rank; any unreadable one, another wallet's and an earlier session's without
such history are dropped on the next write. Each cookie still expires 24
hours after its own last write:
this is a bounded lifetime, not durable preservation. After that, recovering
the outcome needs the runtime's own record
(`docs/proposals/runtime-write-status-r20.md`).

A launch journal holds at most six entries (`JOURNAL_MAX_ENTRIES`). Only a
`cancelled` or `settled` entry makes room. An entry whose authority left the
wallet (`assertion_issued` or `submitted`) is never evicted to make room and
never aged out of the journal. A runtime write (a Warranty & Service write, a
transfer offer or cancellation, `kind: "runtime"`) is sent by the face, so the
wallet never sees its answer. The wallet records the write's exact request
hash when it issues its assertion. It settles the entry only from the runtime's
own verified record of exactly that write: `write.status`, **proposed contract
r20, not deployed by any runtime** (`docs/proposals/runtime-write-status-r20.md`).
That happens on the face's status read of the write, and when a `begin` finds
no room (the two oldest held writes are read). Anything but an exact verified
`write_applied` answer keeps the entry held, and nothing is ever re-sent.
Every deployed runtime today answers that read as unknown, so against them
these entries stay `assertion_issued`.

When nothing can make room, a `begin` is refused `journal_full` (409) before
anything is confirmed or minted. The face hears `temporarily_unavailable`; the
host, in its own UI and only while that launch is live, shows a notice
offering **Restart the application**: the same face launched again with a new
launch ID and an empty journal, under the same wallet session. Nothing is
re-sent for the earlier launch, and its journal is kept under the cookie rules
above; a restart that would need to drop it opens read-only instead
(`launch_capacity` on its writes). On start-up the new launch reads back only an unsettled
transfer step the wallet sent from another kept launch; a registration is
recovered only when the face asks for its id; a Warranty & Service write or
quote decision is not read back. Against today's runtimes, a full Passport
registration, a Warranty & Service case with its writes and quote decisions,
and a transfer therefore take more than one launch. Under r20 they fit in
one.

It holds IDs, hashes and phases only: operation ID, kind (`registration`,
`runtime`, `settle`), operation or action name, object, case, phase
(`confirming`, `confirmed`, `assertion_issued`, `submitted`, `settled`,
`cancelled`), settled status, the settle's proposal ID and executed action ID,
the registration record ID and confirmed request hash, a hash of the host-read
quote `{quote_version, amount, currency}`, timestamps, the launch's current
selection and the expiry times of its outstanding assertions (at most six
entries; finished ones make room). It never holds proposal or quote content,
an assertion, signature, token or face text. It is cleared on sign-out and
replaced after an account change; a session that ends otherwise (expiry, a
closed browser) leaves it, sealed to that session, for its own 24 hours. A
cookie rather than Web Storage keeps it outside the iframe's and page
scripts' reach and inside the existing session boundary.

**Registration history (exact operation, read-only).** A status read
(`GET .../operations/[operationId]`) for an operation that is not in this
launch's journal looks for exactly that operation id in the browser's other
launch journals sealed for the same wallet ID (the session's, from
`getWallet`), face and programme, in any session of that wallet: a reload,
another tab, or a sign-in since. It uses the entry only when exactly one
journal holds the id as a registration whose one `registration.submit`
assertion its launch issued (open, registered or closed). Other journals may
carry the same id without having issued it (a launch that resumed it with
Finish registration records it as observed, or one began it and never
issued); they must name the same registration of the same unit. When two
journals issued the id (two launches that both began it before either
issued), or another entry under the id names another unit or is not a
registration, nothing is recovered. It then reconciles that one operation
exactly as its own launch would: the canonical readback, and the runtime's
`registrations/status` for that operation under the current session (the
runtime binds it to the holder), registered only when the runtime says so and
closed (`runtime_never_accepted`) only on the same proof. The result is
derived on every read and never kept: the entry does not join this launch's journal and
the original journal is neither rewritten nor re-sealed. Another wallet, face
or programme finds nothing; the history is never listed; no assertion is
minted for the face, and no transition applies, for a recovered operation;
and no launch begins a new operation under the id of such a registration
(`operation_already_submitted`).

**What decides, and what does not.** The journal and the BFF's in-process
double-submit damper are not idempotency and decide nothing across tabs,
instances or servers. The runtime does (contract r8/r11): its one-time `jti`,
the settle dispatch claim (below), its unit-level registration single flight
(a second `registration.submit` for a unit with a pending or unknown operation
is refused with `operation_conflict` and names the existing operation) and its
per-version quote decisions. Recovery after a reload or a fresh sign-in, with
no journal, is read-only: `registration.pending.read` resumes the original
registration and `registration.settle.status` reconciles a settle.

### Durable recovery of unresolved and unseen outcomes (proposed r20)

**Status: the runtime side is contract r20 with amendment r20.1
(`docs/proposals/runtime-write-status-r20.md`), agreed with Root for source
implementation and not yet deployed by any Studio runtime; source agreement
is not hosted acceptance.** The wallet consumer is in place and fails closed:
against today's runtimes nothing below is listed or acknowledged, and the
cookie-based retained listing (`retained` on the operations list) keeps
working as before. A Dual-backed write (a linked `case.open` that mints and
updates) is proved only by the r20.1 receipt chain, one verified effect per
intended Dual action; a record intending effects the chain does not prove is
held.

Why: the launch cookies are the wallet's only record of what authority left
it. Each expires 24 hours after its last write, sign-out clears them, and
another account's sign-in on the same browser drops them. A holder whose
transfer step was won and executed but whose answer was lost, and whose unit
has since left their inventory, could not learn the outcome from this wallet
once that cookie was gone.

What the host does on each face launch, after the bootstrap
(`GET /api/faces/[slug]/recovery`):

- It asks the face's own runtime and its linked Warranty runtime for this
  wallet's own unresolved and unacknowledged operations (`recovery.list`),
  following each scan's pages to the end. Every page's echoed holder, wallet,
  issuer, application, programme, artifact and request id is compared with
  the session, this host and the face binding; nothing is taken from the
  endpoint having answered.
- Each listed item of a journey this host enables is resolved read-only, in
  the contract's stable order and at most 25 per page, the host following the
  listing's sealed continuation to the next page within the same launch (up
  to eight pages per collection; when items remain the notice says so and
  offers **Continue checking**, which resumes from the kept continuation; a
  page it cannot read makes the check incomplete until it is re-read),
  through the existing resolver of its kind: `registration.status` for a
  registration, `registration.settle.status` for a settle,
  `transfer.status` for a transfer step, `write.status` for a Warranty &
  Service write or a transfer offer. A proved outcome
  carries the contract's `outcome_proof`, whose hash the wallet recomputes.
  Items of a disabled journey are neither resolved nor acknowledged
  (`withheld`). An id listed twice is not checked. An item the runtime lists
  but the wallet can read only by its identity (operation id, kind, state and
  recorded time; a record the runtime retains however malformed, contract §2)
  is kept as `unreadable`: never resolved, never acknowledged, and that
  runtime's check is incomplete for that reason; an item without even an
  identity makes the page unreadable. Every answer names each runtime asked
  in `checks` (`product`: the face's own runtime; `service`: the linked
  Warranty runtime), with `checked`, `incomplete`, `unavailable` or
  `unsupported` and the cause (`runtime_incomplete`, `echo_mismatch` with
  the mismatching fields in `detail`, `time_invalid`, `snapshot_changed`,
  `cursor_cycle`, `out_of_order`, `pages_exceeded`, `read_failed`,
  `item_unreadable`, `unreachable`, `invalid`, `unsigned`), so an incomplete
  check is diagnosable from the response alone. A holder is an address: the
  API writes it in EIP-55 mixed case, the wallet's assertions and the
  runtimes carry, store and echo it in lowercase, so every comparison of a
  holder with an echoed or recorded one is case-insensitive
  (`sameHolder`), never string equality.
- The host shows what it proved in its own notice (never face text), with held
  and unknown items as still being confirmed. The notice also says, per
  runtime asked, whether the person's product records and service records
  were checked and, when not, why in plain words, counts the records this
  wallet could read only by identity ("could not be read by this wallet and
  were not checked"), and for an incomplete check without a continuation
  offers **Check again**, which re-lists from the start while the launch is
  live. Nothing recovered is re-sent,
  re-reserved, re-minted for the face or executed, and this launch's journal
  is never written by the listing; a held runtime write of this launch that
  a complete scan named comes back as a discovery ticket the host hands
  straight back, which marks that entry `discoverable` (retention above) and
  frees no journal slot.
- When the person dismisses the notice, the host acknowledges
  (`POST /api/faces/[slug]/recovery/ack`, `recovery.ack`) only the items whose
  outcome was proved in this launch, whose journey is enabled, and only when
  every scoped runtime's scan was complete. The acknowledgement names the
  outcome's hash through a sealed ticket the listing issued to this session
  and launch; it records delivery beside the runtime's immutable record and
  modifies nothing. An incomplete check (`complete: false`) acknowledges
  nothing, and the notice says that not every request could be checked.
- When no runtime of the face answers r20 (`supported: false`), the host
  behaves exactly as before: the cookie-based retained steps are read.

What this does not do: it never frees a journal slot (only a `begin` or a
status read of a held write does, through `write.status`), never treats a
refused, unknown, foreign or mismatched answer as an outcome, and never
raises the cookie, launch or journal limits.

### Application-variant bridge

`core/product-transport.ts` starts the channel only for a frame at the exact
bound origin under the pinned path. The ready `application` must be exactly
`{id, version, publisher, programme, artifact, contract}` and each value must
equal the binding (exact version); anything else closes the channel. The
initialize context is `variant: "application"`, `object_id: null`,
`object: null`, the application `{id, version, publisher}`, programme
`{id, name}`, task and capability names; no wallet ID, address, token, cookie,
assertion or DTO.

| Operation                           | Wallet behavior                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bridge.ping`                       | `{pong: true}`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `programme.context.read`            | application, programme, `selected` (`null` or `{context_id, object_id}`), `signed_in`                                                                                                                                                                                                                                                                                                                                                                        |
| `programme.products.list`           | `listObjects` for the session wallet per programme template; minimized projection; host-held opaque `next`                                                                                                                                                                                                                                                                                                                                                   |
| `programme.product.select`          | server-side selection (above); replaces and invalidates the previous `context_id`; the change event follows the response                                                                                                                                                                                                                                                                                                                                     |
| `programme.product.read`            | fresh `getObjectById` for the current context; a product no longer held clears the selection                                                                                                                                                                                                                                                                                                                                                                 |
| `programme.product.attributes.read` | the selected product's attributes as `{key, value}`                                                                                                                                                                                                                                                                                                                                                                                                          |
| `programme.product.history.read`    | `listActionLogs` for the selected object: `{action_id, action, status, when}`, no params, signatures or fees                                                                                                                                                                                                                                                                                                                                                 |
| `navigation.task.update`            | validated task path and optional plain-text title; mirrored to the wallet URL                                                                                                                                                                                                                                                                                                                                                                                |
| `programme.registration.authorize`  | payload `{object_id, operation_id, record_id, request_hash}`; public unit facts; refuses `not_in_programme`, `record_mismatch` (record_id is not the projection's `custom.recordId`), `already_registered_to_you`, `ownership_moved_state_pending`; journal `confirming`; native confirmation with canonical facts, programme, publisher and the user's own wallet; journal `confirmed`; mint `registration.submit` with the face's `request_hash` unchanged |
| `programme.operation.status`        | read-only status; `outcome_unknown` becomes `pending` only for an operation this live host issued                                                                                                                                                                                                                                                                                                                                                            |
| `programme.runtime.authorize`       | reads mint directly for the selected product; case writes need native confirmation and a journal entry; quote decisions bind the host-read quote                                                                                                                                                                                                                                                                                                             |
| `programme.product.settle.request`  | G6, below                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Payloads reject unknown keys. Product-scoped results carry `context_id`; a
private result whose context changed while it was in flight is dropped with
`stale_context`, while an approved write may complete. One native
confirmation is pending per face (`action_in_progress`). Host events use the v1
`dual.face.event` envelope: `programme.context.changed`,
`navigation.task.restore`, `session.ended` and `operation.updated`.

Registration never maps to Dual's `claim_ownership`, which claims an object on
chain as a collectible and is not holder ownership. The application variant
offers no `object.*` operation, so `object.action.request` cannot be used, and
`claim_ownership` is refused as a settle action at every layer.

**Canonical status.** Registered requires the readback owner to equal the
session wallet's account address, the Dual state in `settledStates` and the
lifecycle target absent or equal to that state. Owner equality with a state
in `unconfirmedStates` (`Transfer pending`) is `ownership_moved_state_pending`,
never registered. Owner equality with an ended state or a disagreeing
lifecycle target is `recovery_required`. After the assertion is issued, a unit
not yet held by the wallet is `outcome_unknown`; the original operation is
kept and never re-minted. After a reload the host lists journal entries whose
authority already left the wallet, reconciles them read-only and reports
`operation.updated`.

**G6 holder settle.** The face sends only `{context_id, operation_id,
settle_operation_id}`. The host re-reads the selected product (held by the
wallet, in the programme, state in `settle.fromStates` and
`unconfirmedStates`, else `settle_not_required`), obtains the proposal itself
through the BFF, and requires it bound to this unit and original operation,
unexpired, the configured action, an input whose leaves are exactly the
template's leaves (no key more or less at any level) with every leaf passing
its rule, the state and lifecycle target it writes agreeing, a proposal hash
equal to `sha256(canonical {object_id, action, input})`, and the action
available in a fresh read. The leaf rules (contract r5) are `{literal: v}`,
`{enum: [...]}` (reviewed target states only), `{unchanged: true}` (equal to
the fresh host-read object value at that `custom` path) and
`{runtimeIssued: r}`, where `r` is an anchored regular expression or one of
the wallet-defined format names Studio emits: `sha256_hex` (64 hex),
`sha256_prefixed` (`sha256:` + 64 hex), `token`
(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$`), `iso_time` (ISO 8601 with zone) and
`public_fields` (at most 32 plain-text strings of at most 200 characters). The
registry accepts the template nested under `inputTemplate`, or flat as Studio's
`productFaceSettleInputTemplate()` exports it (`inputPath` plus `leaves`); both
become one leaf map. Because api-v3 does not state whether an Update merges or
replaces nested `data.custom` (contract r7), the input must carry the
COMPLETE custom map (contract r17 completeCustomMap): the template lists the
GOVERNED leaves only and says `preserveUnlisted: true`. Every other key of
the host's own fresh read must be in the input, deep-equal to that read (a
Studio-minted unit's activation mint keys, `activation_hash`,
`dual_asset.*` and the like, are copied unchanged by the runtime), and no
input key may be absent from the fresh object unless the template lists it.
A template without the flag is refused (`proposal_rejected`). The journal
entry binds a hash of the fresh custom map at `begin`; the BFF re-reads the
unit at confirm and again before the reserve and refuses
(`proposal_rejected`, pre-send, the entry still cancellable as
`not_submitted`) if it changed in any way. The templates come from the
runtime's read-only template inspection; `api/product-face-conformance.test.ts`
runs this checker on real Studio proposals recorded by Studio's
`scripts/qa/product-face-conformance-fixtures.mjs`. The confirmation shows the decoded field changes from the
proposal and the fresh object; runtime-issued commitments (hashes, ids,
timestamps) are listed separately under a technical disclosure, and values that
stay the same are not shown.

**Executing after a won reservation (settle and transfer steps).** A
holder-signed step captures the signing wallet session (wallet ID, holder
account, sign-in method, controller) when it begins. After the awaited
reservation answers `dispatch: "won"` the capability re-asserts, before
calling the executor, that the face session is live, the same product
selection is current and the wallet session is exactly the captured one. The
host's executors check the same again themselves (defence in depth) and run
only while their own launch is live, so an account change, logout, expiry,
torn-down launch or new selection during that await never reaches a
signature, and never signs with another account's credentials. Such a step is
not executed, cancelled, retried or reserved again: its journal entry stays
submitted under its original correlation, its status reads `outcome_unknown`,
and only the runtime's reviewed recovery can release it.

**Binding prepare and execute to the session that won (contract r18).** The
existing executor prepares, signs and executes through the wallet's own
`/api/backend` proxy, which forwards each request under the session cookie
current at that request. For a face step every prepare and execute therefore
carries `x-dual-face-launch`, `x-dual-face-slug`, `x-dual-face-operation` (the
settle or step operation ID) and `x-dual-face-wallet` (the wallet ID captured
at begin); none is a credential and none is forwarded upstream
(`app/_domain/face-execution.ts`). Before any upstream request the proxy
(`api/face-execution-binding.ts`) requires, for the CURRENT session:

- `POST ebus/prepare` or `ebus/execute` only;
- the current wallet is the captured wallet;
- this launch's journal, sealed to the session and wallet that wrote it and
  read as empty under any other, holds the operation as a settle or transfer
  step that is `submitted`, whose own reservation this launch won (the journal
  marker `dispatch: "won"`, written only by the submit that received it), and
  that has no recorded action;
- the body is exactly one action, the step's own (settle: its template action,
  alias allowed; transfer request: `update`; transfer: `transfer`; never a
  permit secret), on the step's own unit.

Otherwise it answers `session_expired` (401), `launch_required`,
`face_execution_invalid`, `face_execution_path_invalid` or
`face_execution_mismatch` (400), or `face_execution_unbound` or
`face_execution_not_pending` (409), and nothing reaches Dual. Inside the
executor the identity is re-checked before preparing, after preparing, after
signing (passkey or EOA) and immediately before executing, so a change at any
of those awaits stops the step before anything else is sent. A refused or
stopped step is handled as above: no cancel, retry or second reservation.
Requests without these headers are the wallet's generic executor and are
unchanged. The journal is a cookie, so the proxy cannot make a second execute
by the same session atomic; exactly-once dispatch stays the runtime
reservation, and the host executes only after its own `won` and never retries.

**Settle reservation (contract r8/r11).** After the confirmation the BFF
records the settle as `submitted` and, before ANY holder execution, calls the
runtime's `registration.settle.reserve` server to server (assertion operation
`registration.settle.reserve`, `op_id` the settle operation ID, target
`{object_id}`, `request_hash` over exactly `{proposal_id, settle_operation_id,
object_id}`). The existing executor then runs exactly that proposal as the
holder (email execute, or passkey/EOA prepare, sign and execute) ONLY when
this request itself received `dispatch: "won"` for exactly this proposal,
operation and unit — the single call that created the runtime's durable
reservation. An idempotent replay or `already_claimed`, `already_reserved`,
any refusal or error, a timeout or a lost reserve response executes nothing,
is never re-reserved, and is `outcome_unknown` for the face, which reconciles
read-only through `registration.settle.status` (the runtime finds the holder
action in Dual's action logs, or the outcome stays unknown). A cancel before
the reservation is `not_submitted`; a lost or failed execution is
`outcome_unknown` and is never re-executed.

**No release (contract r13).** A settle that left the wallet (won, or its
reserve answer lost) is never released or replaced from the host. Proposal
expiry plus an empty history is not evidence that nothing executed: the host
status stays `outcome_unknown` (or follows the canonical readback once it
shows the settled state), the entry cannot be cancelled into
`not_submitted`, it is kept as long as its launch cookie lasts (24 hours
from that launch's last write; the journal itself would prune an open entry
only after 7 days), then the status is unknown, never "not submitted"; and
the same launch refuses a replacement settle of that unit
(`operation_conflict`) before asking the runtime. Another launch may ask,
and the runtime's reservation refuses it.

**No proposal (G6b).** The runtime originates the brand's proposal; when it
has none it answers `settle_proposal_unavailable` with a reason
(`issuer_preauthorisation_absent`, `issuer_preauthorisation_expired`,
`issuer_auto_proposal_used`, and since r12 `issuer_settle_policy_absent`;
`face_settle_proposal_stale` when the brand's open confirmation was prepared
for an earlier revision of the product's record, and
`face_settle_proposal_release_changed` when it was prepared under an earlier
app release or template, so the brand proposes it again). The host shows that
reason in its own notice and invents nothing; any other reason is dropped and
the notice is not shown. The face receives `settle_proposal_unavailable`.

Status stays `ownership_moved_state_pending` until the
readback shows a settled state with an agreeing lifecycle target.

**Case targets (contract r10).** Every case write names its case: `case.open`
opens the case Studio prepared for the holder's unit (it never creates one),
so its target is exactly `{object_id, case_id}`, like `case.read`,
`case.evidence.submit` and `case.information.provide`. A case write without a
well-formed case id is `invalid_request` in the bridge, the journal begin and
the mint, before any confirmation or request.

**Quotes.** Before `case.quote.approve` or `case.quote.decline` the BFF reads
`case.read` itself, records a hash of the quote in the journal and the confirmation
shows quote version, provider (labelled as from the publisher), the exact
decimal amount formatted in the active locale without a float, and that no
payment is taken. The write assertion's target binds
`{case_id, quote_version, amount, currency}`; a different quote from the face
is refused with `quote_changed` and needs a fresh read and confirmation.

**Face-enabled handover (contract r14).** A new face-enabled handover link
goes to the face runtime first; the runtime exchanges the grant itself and
sends the browser to `https://<wallet>/products/<slug>/handover#ticket=<ticket>`
(the fragment only). That wallet route works signed-out (the request proxy
neither protects it nor accepts it as a return path, so a sign-in redirect
never carries the fragment along). Its client reads the fragment and strips
it with `history.replaceState` before anything else, then posts the ticket to
`POST /api/faces/[slug]/handover`. Only a registry slug whose binding has
`handover: {enabled: true}` stores anything: the ticket goes into one sealed
(AES-256-GCM, purpose-bound, the slug inside), HttpOnly, host-only,
`SameSite=Strict` cookie, `Secure` in production, that lives ten minutes.
Then the page replaces itself
with `/products/<slug>/register`, which a signed-out visitor reaches through
sign-in with the validated `next=`. On the register task the context read
(`?task=/register`) takes the ticket and clears the cookie in the same
response; the client keeps it in memory for that launch only (not in the
query cache, a URL or storage) and the host puts `handover: {ticket}` into the
application-variant initialize context exactly once, on the register task
only. Another task, another slug, a reload or a replayed read hands nothing
over.

Account isolation is enforced on the server, never by the client:

- A ticket stored while signed in is sealed with that session's
  `{walletId, sidHash}`. One stored signed out is anonymous.
- Establishing a session (sign-in, registration, passkey, EOA;
  `api/session-establish.ts`) binds an anonymous ticket to the account that
  signed in, moves one of the same wallet to the new session, and clears one
  bound to another account in that same response.
- The context read hands a ticket over only when its binding equals the
  current session's `walletId` and `sidHash` (or it is still anonymous, then
  bound by that first authenticated read). Any other account's or session's
  ticket is cleared and nothing is handed over.
- A signed-in handover whose session cannot be read now is refused rather
  than stored unbound.
- Logout and session expiry clear the cookie. The client also forgets
  launch-local tickets on every session end, and on an account change asks
  `DELETE /api/session/face-handover`, but nothing depends on that request.

**Protected transfer (G8, contract r16).** The holder's face asks for
`programme.product.transfer.sign {context_id, offer_id, step_operation_id}`.
The wallet reads the next reviewed step itself from the bound runtime
(`POST /api/faces/[slug]/transfer-proposal`, a trusted server-to-server
`transfer.propose` that also names the recipient the runtime bound from the
recipient's own assertion), accepts it only for the selected owned unit and
that recipient (request step: exactly the deployment's `transferRequest`
template under the same complete-map checker as a settle, from one of its
`fromStates`, writing `Transfer pending`, with a proof event naming
`recipientReferenceHash:<sha256 of the recipient>`; transfer step: exactly
`transfer {to: <recipient>}`; never the holder, the proposal hash checked;
without `transferRequest` the operation is `capability_not_granted`), and
shows its own confirmation naming the product,
that ownership moves, and the recipient's wallet (shortened). The step is
journalled (`kind: "transfer"`, offer and proposal ids only) before anything
leaves the wallet; the confirmed step is reserved at the runtime
(`transfer.reserve`, server to server) and the holder executes it through the
existing executor only on that request's own `dispatch: "won"` with
`executionPermitted`. The runtime deciding for a cancel or an expiry first is
`transfer_cancelled` (nothing executed); anything else is `outcome_unknown`.
Afterwards `POST /api/faces/[slug]/transfer-progress` verifies the step with
the recorded action, or reads `transfer.status`; asking again with the same
step operation id only reads. A step another launch of the same wallet
submitted (a reload, another tab, a sign-in since) is read the same way from
that wallet's own sealed history for this face and programme
(`readFaceHistory`), read-only: it never joins, re-seals or settles the
current launch's journal, and another wallet's journals give nothing. The
host's `programme.product.transfer.sign` asks this first, with the request's
`offer_id`, before any ownership read: a submitted step is only ever read
back, even when the sender can no longer read the moved object, and the face
keeping its step ids in memory only (a relaunch gives it a new one) changes
nothing, because the one step of that offer this wallet already sent (under
its original operation id and recorded action) is read instead. Only a step
the BFF reports `unknown_operation` or `operation_conflict` is signed; more
than one sent step for the offer is `outcome_unknown`, never guessed. Another
launch's entry is never settled here, so a request step found this way, once
the runtime reports it committed, is finished: the new id reads
`unknown_operation` and the offer's custody step, never sent, is signed the
normal way (proposal, confirmation, reservation); the request keeps its one
runtime reservation and is never reserved or executed again, and its own id
still reads committed. A step id this wallet already knows, asked with
another `offer_id`, is `invalid_request` before anything is minted or asked,
and the host signs nothing for it. Since the sender can no longer list or
select a product whose custody moved, the host also reads such a step once
when the face launches: `GET /api/faces/[slug]/operations` lists it under
`retained`, and only the runtime's answer (its exact action, signer,
recipient and proof) is reported, as a native notice, and only while that
launch's host is live: an answer that arrives after a frame reload, a
teardown or an account change is dropped and starts no further read.
`transfer.offer` and `transfer.cancel` are host-confirmed runtime writes for
the selected product; the recipient's `transfer.offer.read` (target `{}`)
and `transfer.accept` (target `{object_id}`, r19) and either party's
`transfer.read` need no selection, and `transfer.accept` is confirmed
natively first. The acceptance link opens the runtime's accept page, which
continues to
`/products/<slug>/handover#accept=<ticket>`; the entry stores it as kind
`accept` in the same sealed, account-bound cookie and continues to
`/products/<slug>/accept`, where the context read (`?task=/accept`) hands it
to the face once as `acceptance: {ticket}`.

**Accept names the product (r19).** The same context read also keeps
that acceptance ticket for the BFF only: a sealed (AES-256-GCM,
purpose-bound), HttpOnly, SameSite=Strict, host-only cookie
(`__Host-dual_face_acceptance` in production) bound to the slug, the launch
and the session (`walletId`, `sidHash`), for at most the ticket's ten
minutes; logout, session expiry and an account change clear it. The ticket
is never put in another response, a URL or the face again. Before its
`transfer.accept` confirmation the wallet calls
`POST /api/faces/[slug]/accept-offer` (empty body): the BFF reads which unit
the acceptance is for itself, server to server with the session's own
assertion (`transfer.acceptance.read`, input `{acceptance_ticket}`, target
`{}`; the runtime answers only `{object_id}`), then reads that unit from
Dual's public projection, requires its template in `binding.templateIds` and
that this wallet does not hold it already, answers `{unit}` (the unit's
canonical facts: name, projection fields, readback; never an owner address,
a case or a document) and binds the unit to the kept acceptance. The
wallet's confirmation names that unit (its name and the programme's
projection fields, and the user's own wallet), and an assertion for
`transfer.accept` is minted only for target `{object_id}` equal to it: a
face naming another unit is `stale_context`, and no kept or read acceptance
for this launch (a pasted link, another tab or session, an expired ticket)
is `invalid_request`; nothing is confirmed or minted. Runtime refusals map
to `already_registered_to_you` (the offer's own holder, or a unit this
wallet holds), `transfer_cancelled` (cancelled, expired, used or unknown
offer), `invalid_request` (the acceptance ticket unknown, used, expired,
unbound or for another binding), `not_in_programme` and
`runtime_unavailable`. A transfer link pasted into the face can still be
previewed, but it can be accepted only by opening it, so the wallet holds
its acceptance.

An unknown slug, a binding without
handover or a malformed ticket shows an error and stores nothing. The ticket
itself is a one-time capability at the face runtime (`/handover/redeem`);
the wallet's cookie clearing is not a server-side single use, so two context
reads racing with the same cookie could both carry it, and only the runtime's
redeem decides.

**Session teardown.** `SessionProvider.onSessionEnd` notifies before logout
revokes the session, on expiry and on an account change. The host sends
`session.ended`, closes the channel, removes the frame, clears the selection
and product-face queries, and resolves an open confirmation as cancelled. After
an account change the user may reopen the face for the new account.

### Local cross-origin harness

`npm run test:e2e:product-face` (`playwright.product-face.config.ts`) runs
the actual wallet (`next dev`, browsed at `http://demo.localhost:3000`, probed
at `http://127.0.0.1:3000/login`), the local fake api-v3 `e2e/mock-api.mjs` at
`127.0.0.1:4010`, and `e2e/product-face-fixture.mjs` at `localhost:4101`, which
serves the pinned artifact emitted by the Studio worker into
`e2e/fixtures/product-face/<applicationId>/<version>/<hash>/` and a labelled
fake of the runtime endpoints. Ed25519 test keys are generated per run and
never written to disk. With `MOCK_PROGRAMME_DUAL_URL` set, the fake api-v3
forwards programme-template object reads to the Studio local fake Dual
(integrated mode). Where Playwright's own Chromium build is not installed,
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` names the browser binary. The fixture is
byte-exact and excluded from formatting and linting; it is the Morrow Home face
emitted by Studio `b4ded3d`. The registration specs run only when the pinned
face's `manifest.contractRevision` is at least 6 (the r6 authorize payload); an
older pinned face skips them with that reason.

The fake runtime follows contracts r8 to r11: opaque evidence handles, a
unit-level registration single flight (`operation_conflict` naming the existing
operation), registration answers with `nextStep` and `settleProposal`,
runtime-originated proposals carrying the unit's complete custom map (35 leaves
for the seeded Morrow units) or `settle_proposal_unavailable` with its reason,
`registration.settle.reserve` with one atomic dispatch claim (`won` once,
`already_claimed` for every later call, the same settle operation included),
`registration.settle.verify` requiring that reservation, the read-only
`registration.settle.status` (from the fake api-v3 action logs),
`registration.pending.read`, and the r14 handover page
(`/face/handover/<applicationId>`), `/handover` (one-time ticket, ten minutes)
and `/handover/redeem` (consumed once, answering what `/evidence` answers). Test modes lose reserve answers
(`/__test__/mode {loseReserveResponses}`) or execute answers (fake api-v3
`/__test__/mode {loseExecuteResponses}`). The suite checks, in Chromium, that
every cookie stays within 4096 bytes and is stored with two concurrent launches
and a 35-leaf proposal (each launch cookie measured at about 0.5 to 1.5 KB),
that two tabs settling the same original operation with the same settle
operation execute exactly one holder action, that a lost reserve answer
executes nothing, that a lost execute answer reconciles read-only, and that a
fresh sign-in recovers the original operation's status read-only.

Integrated mode with the real Studio runtime (`scripts/product-face-harness.mjs`
in the Studio repository) serves the face and runtime at
`http://localhost:4180` and a fake Dual at `127.0.0.1:4011`, and writes a wallet
env snippet (`--env-out`; it holds an ephemeral signing key and is never
committed). Start the fake api-v3 with that snippet and
`MOCK_PROGRAMME_DUAL_URL=http://127.0.0.1:4011`: it then forwards object,
listing and action-log reads for the bound templates and the holder's own
`POST /ebus/execute` (with `x-local-fake-wallet: <holder>`) to the Studio fake
Dual, and synthesizes only the standard `update` action availability that fake
lacks. The fake api-v3's session account is
`0x1234567890abcdef1234567890abcdef12345678`, the harness default holder.
`FACE_ASSERTION_ISSUER` from the snippet is not read: the wallet derives `iss`
from the exact tenant host. The snippet's registry entries must be in the
wallet's registry form above; in particular the linked Warranty runtime is
`linkedRuntimes[{purpose: "claims-warranty", applicationId, origin,
instanceId}]`, and an entry naming it otherwise (the Studio harness at
a2b04b9 writes the r10 proposal form `linkedCases`) is dropped fail-closed,
so every face of that entry answers `unknown_application`. The wallet runs
in development for this mode (`npm run dev`): a production build accepts
only `https` face origins.

## Change impact guide

### Rendering or aspect-ratio change

Update the domain adapter, `ObjectVisual`, card/detail CSS, and component tests.
Verify a real external face at phone width and its declared desktop ratio.
Confirm the standard metadata fallback still works.

### New display field or FaceView behavior

Change `api-v3` schemas and gateway bundle first, regenerate/synchronize the
web SDK, update the wallet adaptation, then update face/template authoring docs and
Console App editing if publishers need to set the field.

### New bridge operation

This is a cross-repository protocol change. Update, in one coordinated review:

1. canonical protocol and security docs in `external-faces`;
2. strict child schemas/client and tests;
3. The wallet capability module, injected handler, limits, and tests;
4. the DPP UI with capability detection and safe error states;
5. `api-v3`, SDK, or BFF routes when backend data is required.

For a service-book integration, use narrow operations such as
`service_book.entries.list` and `service_book.entry.read`; bind them to the
current object and cap pagination. Do not expose a URL or arbitrary request
options through the bridge.

### New trusted face application

Register the exact application ID, semantic major, HTTPS origin, and narrow path
prefix. Review hosting ownership, CSP, manifest, bridge implementation, and
release process before changing the wallet environment values.

## Verification

Run the smallest relevant test first, then:

```bash
npm run check
npx playwright test -g "authenticated external face"
npm run build
```

Required regression cases include public/private separation, fallback display,
wrong origin/path/application/major, malformed and unknown envelope fields,
duplicate IDs, request/response limits, rate limiting, timeouts, iframe
navigation/unmount, capability denial, object-ID injection, action
cancellation, and absence of tokens/signatures from all messages.

No unit or E2E test may call production APIs, sign a real challenge, mutate a
live object, or deploy.

## Release coordination

Before deploying an integration change, confirm:

- the face manifest identity matches its bridge-ready identity;
- the face semantic major matches wallet's application binding;
- the exact production URL is under the registered path prefix;
- api-v3 and generated SDK changes are already compatible;
- the face handles a missing optional capability without breaking rendering;
- The wallet and face deployment order is backward compatible;
- public mode still works with no authenticated bridge;
- a prior immutable face release and prior wallet revision are available for
  rollback.

Deployment, promotion, template reassignment, and live object actions are
state-changing operations and require explicit human authorization.

# Repository Guidelines

For changes that originate in api-v3 or affect generated SDK contracts, follow
the internal contract-first change flow before editing the wallet. Refresh
`api/web-sdk/**` only through `npm run sdk:sync`; never hand-edit it as the
source of an API change.

The focused development guides below are normative. Read every guide whose
scope is affected before editing implementation or tests:

- The wallet routes, product behavior, disclosure, local persistence, or external
  faces: `docs/development/wallet-product-guidelines.md`.
- Components, styles, interaction primitives, copy, formatting, or responsive
  behavior: `docs/development/ui-accessibility-guidelines.md`.
- Domain models, adapters, services, SDK usage, errors, or async workflows:
  `docs/development/architecture-logic-guidelines.md`.
- React components, Server/Client boundaries, state, hooks, forms, context, or
  TanStack Query: `docs/development/react-state-guidelines.md`.

These guides refine the repository rules; this file wins if a genuine conflict
remains. Keep the guides synchronized with architectural changes.

- Repo: https://github.com/DualOrg/dual-wallet
- Several boundaries below name sibling repositories (`../api-v3`, `../web-sdk`,
  `../console-app`, `../smarttoken`, `../viewer`, `../external-faces`). Those are
  internal and are not published with this one. Everything needed to run, test,
  and deploy this app is in this repository; the sibling notes only say where a
  contract is decided.
- The wallet is the end-user SmartToken application. It authenticates a wallet
  account and gives that user access to their inventory, object details,
  activity, and account settings.
- Build the application as a strict TypeScript, React 19, Next.js App Router
  application.
- Canonical boundaries:
  - HTTP contract and endpoint semantics: sibling `../api-v3` repository,
    especially `api.yaml`, `routes/`, and `schemas/`.
  - Generated TypeScript client: sibling `../web-sdk` repository. It is
    generated from `api-v3` and is the transport/type boundary used by the wallet.
  - Visual language, colors, typography, spacing, and component treatment:
    sibling `../console-app` repository.
  - SmartToken backend and on-chain behavior: sibling `../smarttoken`
    repository. The API and chain remain authoritative for state and ownership.
- Keep three meanings distinct throughout the code:
  - a SmartToken `Wallet` is the authenticated API account;
  - an EOA wallet connection is one authentication/signing method;
  - The wallet session is the app's server-managed authenticated session.

## Target Product Scope and Routes

- Email/password is the default and first-visible authentication method. EOA
  and passkey are supported alternatives, not prerequisites for opening the
  app.
- Unauthorized routes:
  - `/login`: email/password first, with explicit EOA and passkey alternatives.
  - `/register`: email account registration by default, plus EOA connect and
    passkey registration entry points.
  - `/verify`: wallet/account verification using the delivered code.
  - `/forgot-password`: request a password reset.
  - `/reset-password`: consume the reset token and set a new password.
  - `/products/[slug]/handover`: the face handover entry (contract r14). It
    strips a face handover ticket from its fragment, hands it to the BFF only
    for a registry slug whose binding enables handover, and continues to
    `/products/[slug]/register` (through sign-in when signed out). It is never
    a sign-in return path. A G8 transfer acceptance (`#accept=<ticket>`,
    contract r16) takes the same entry and continues to
    `/products/[slug]/accept`.
- The anonymous public object view lives in the sibling `../viewer`
  repository. This app serves no public object route; it keeps only the
  display proxy that its own authenticated faces load through.
- Authorized routes:
  - `/inventory`: the current wallet's SmartToken objects, with loading, empty,
    error, pagination, filtering, and responsive card/list states.
  - `/inventory/[objectId]`: object metadata, assets, status, available faces or
    actions, and user-relevant provenance without exposing raw transport data.
  - `/activity`: the current wallet's `action-logs`, newest first, cursor
    paginated, with useful status/action/date filters and detail disclosure.
  - `/settings`: current wallet profile and account settings, authentication
    information that the API actually exposes, logout, and carefully confirmed
    destructive actions when implemented.
  - `/products`: the programmes in the server-only product-application
    registry, with no selected or owned object.
  - `/products/[slug]/[[...task]]`: a programme's reviewed product application
    full-size in a cross-origin iframe, with stable task links. Follow the
    product application section of `docs/external-face-integration.md` and
    `contracts/dual-product-face-v1.json`.
- `/` redirects to `/inventory` for an authenticated session and `/login`
  otherwise. Authentication pages redirect authenticated users to inventory.
  A branded host (`docs/branded-wallet-hosts.md`) renders its configured home
  at `/` instead, lands signed-in visitors there, and serves only its enabled
  journeys' pages.
- The wallet is an end-user surface. Do not copy console administration,
  organization management, operational dashboards, or role-management screens
  from `console-app`.
- Do not invent API capabilities. If a requested setting, auth-method mutation,
  object action, or recovery step is absent from `api-v3`, document the gap and
  fix the contract/backend rather than simulating success in the UI.

## Target Project Structure

- Next.js App Router source: `app/`
  - Unauthorized account routes: `app/(unauthorized)/`
  - Authenticated wallet routes: `app/(authorized)/`
  - Inventory feature: `app/(authorized)/inventory/`
  - Activity feature: `app/(authorized)/activity/`
  - Settings feature: `app/(authorized)/settings/`
  - Product application host: `app/(authorized)/products/`
  - Product-face BFF routes: `app/api/faces/[slug]/`
  - Stable generated-DTO adapters: `app/_adapters/`
  - Domain models, errors, and view states: `app/_domain/`
  - Wallet use cases and transport orchestration: `app/_services/`
  - Reviewed protocol/integration modules, not general feature business logic:
    `app/_lib/`
  - Deployment/API configuration: `app/_config/`
  - Shared components, hooks, providers, types, and utilities:
    `app/_components/`, `app/_hooks/`, `app/_providers/`, `app/_types/`, and
    `app/_utils/`
  - Wallet-owned design tokens and primitives:
    `app/_components/design-system/`
  - Dedicated session/auth BFF routes: `app/api/session/`
  - Authenticated, allowlisted backend proxy: `app/api/backend/[...path]/`
- Server/BFF support: `api/`
  - Opaque cookie session, access-token cache, refresh rotation, and logout:
    `api/server-session.ts`
  - Explicit backend proxy allow/deny policy: `api/proxy-policy.ts`
  - Generated SDK client construction and backend error normalization:
    `api/web-sdk-client.ts` and `api/backend-error.ts`
  - App-local synchronized generated client: `api/web-sdk/`
- Request routing, locale selection, and route guards: `proxy.ts`.
- User-visible copy and localization: `messages/` and `i18n/`.
- Unit/component tests are colocated as `*.test.ts` or `*.test.tsx`; browser
  tests live in `e2e/`.
- SDK synchronization, field-coverage, translation, and validation automation:
  `scripts/`.
- Architecture, security, field ownership, and deployment notes: `docs/`.
- Static assets, fonts, and association files: `public/`.

## Build Rules

- The app must not expose API tokens to browser JavaScript. Do not introduce
  `localStorage` keys such as `access_token`, `refresh_token`, or
  `viewer_session`.
- The current `api-v3` email login operation is `POST /auth/login`
  (`loginWallet` in the generated SDK); do not implement the obsolete
  `/wallets/login` integration.
- Copy an existing asset only when it is still an explicit product requirement.
  Review `public/.well-known/` association files independently before keeping
  them.
- A Next.js BFF requires a server deployment. Do not recreate the old static
  GCS bundle.

## Build, Test, and Development Commands

- Runtime: Node.js `20.9.0` or newer. Align the production image with the
  current reference app runtime when scaffolding the application.
- Package manager: npm. Use `npm` and preserve the reviewed
  `package-lock.json`; do not substitute Bun, Yarn, or pnpm.
- Install exact dependencies: `npm ci`.
- The repository exposes these scripts:
  - Start development: `npm run dev`
  - Build production output: `npm run build`
  - Serve a production build: `npm run start`
  - Type-check: `npm run typecheck`
  - Lint with zero warnings: `npm run lint`
  - Format configured source: `npm run format`
  - Verify formatting without writing: `npm run format:check`
  - Run Jest: `npm test`
  - Run the complete application gate: `npm run check`
  - Synchronize the generated SDK: `npm run sdk:sync`
  - Install Playwright Chromium: `npm run test:e2e:install`
  - Run browser tests: `npm run test:e2e`
- Add missing baseline scripts as part of the Next.js scaffold before relying
  on them in CI. Do not weaken a check merely to make a build pass.
- Build, push, and deploy targets are state-changing. Never run `deploy.sh`,
  publish an image, update a bucket, or deploy Cloud Run without explicit user
  confirmation.

## Coding Style and Conventions

- Language: strict TypeScript with React 19 and the Next.js App Router.
- Use the `@/` path alias for repository-root imports when it improves clarity.
- Prefer precise types and narrow unions. Avoid `any`, unchecked casts, and
  duplicate local versions of generated SDK types.
- Keep generated transport DTOs at the boundary. Convert them into stable
  the wallet domain/view models in `app/_adapters/`; do not let OpenAPI naming and
  optionality spread through presentation components.
- `app/_domain/` never imports React, Next.js, browser APIs, generated SDK
  modules, or SDK clients. Components and pages never instantiate generated API
  clients or construct transport payloads. Follow
  `docs/development/architecture-logic-guidelines.md` and enforce the dependency
  direction with import-boundary linting.
- Respect Server Component and Client Component boundaries. Add `"use client"`
  at the smallest practical interactive boundary for browser state, event
  handlers, wallet connectors, WebAuthn, or other browser APIs. Pages and
  layouts remain Server Components by default.
- Server Components call a server-only data/service layer directly instead of
  making HTTP requests to the wallet route handlers. Browser code calls only
  same-origin, allowlisted routes through browser-safe services.
- Mark session, tenant, upstream-origin, credential, and token-bearing modules
  with `import "server-only"`.
- Never import server session code, upstream origins, refresh credentials, or
  SDK instances containing bearer tokens into client bundles.
- Use React Query for client-owned remote state. Centralize query keys and
  invalidate the smallest correct set after profile or future object mutations.
- Use typed per-feature query-key factories and focused mutation hooks. Raw
  query-key arrays, SDK DTOs, and direct mutation calls do not belong in pages
  or components. Enable the TanStack Query strict ESLint rules when establishing
  the quality baseline.
- Keep protocol values explicit about units and serialization. Use `bigint` or
  Viem-safe values for chain amounts and never use JavaScript floating point for
  token arithmetic.
- Prefer existing design-system primitives for buttons, fields, cards, modals,
  status badges, skeletons, empty states, pagination, and errors.
- User-visible copy belongs in translation catalogs and is accessed through
  `next-intl`; this includes ARIA labels, titles, image alternatives,
  placeholders, metadata, validation, and fallback copy. Format dates, numbers,
  fees, units, lists, and plurals with the active locale; do not hard-code a
  locale in feature code.
- Use brief comments for non-obvious security, WebAuthn, signing, unit,
  pagination, or protocol invariants. Avoid comments that restate the code.
- Keep focused changes focused. Do not combine feature work with unrelated
  dependency upgrades or broad cosmetic refactors.

## Component Design and React Rules

- Give every component one clear responsibility. Route/page components compose
  features; hooks own remote workflows; adapters own DTO conversion; focused
  components own reusable rendering and interaction.
- Separate container behavior from presentation when it clarifies state
  ownership, testing, or reuse. Presentational components receive explicit,
  typed props and do not rediscover auth or wallet state from unrelated globals.
- Keep state close to its owner. Introduce context only for genuinely shared
  state such as session, theme, or connector state.
- Use the URL for non-sensitive filters, sorting, selection, and pagination that
  should survive refresh or Back/Forward navigation. Use local state for
  ephemeral menus, dialogs, and unsaved input. Web Storage is limited to parsed,
  namespaced, non-sensitive presentation preferences.
- Model multi-step authentication, action execution, and destructive workflows
  with discriminated unions or reducers. Avoid parallel booleans that can
  represent impossible states.
- Components and hooks must be pure and idempotent during render. Never mutate
  props, cached query data, context, or module-level objects.
- Follow the Rules of Hooks without exception: call hooks only at the top level
  of React components or focused `use*` hooks, never conditionally or from event
  callbacks.
- Effects synchronize with external systems. Do not use effects for values that
  can be derived during render or for logic that belongs in a user event.
  Complete dependencies and clean up subscriptions, timers, and in-flight work.
- Use `useSyncExternalStore` for genuine external subscriptions. Use
  `useMemo`, `useCallback`, and `memo` only for measured expensive work or a
  required referential contract, not as a default component style.
- Use immutable and functional state updates where appropriate. Use stable
  semantic keys for lists; cursor pages and action logs must not use array
  indexes as identity.
- Model loading, empty, error, expired-session, unsupported-browser, cancelled
  wallet prompt, and success states explicitly at feature boundaries.
- Add focused tests when changing component responsibilities, auth state,
  effects, context, conditional rendering, or accessibility behavior.

## Console-App Design Alignment

- `../console-app` is the visual authority, particularly:
  - `app/_components/design-system/tokens/`
  - `app/globals.css`
  - its shared form, auth-shell, navigation, card, status, and feedback
    primitives.
- Copy or adapt reviewed design tokens into wallet-owned files; do not import
  sibling repository source at runtime. The wallet builds must be reproducible from
  this repository and lockfile alone.
- Preserve the semantic token layering used by Console App. Product components
  consume semantic surface/content/stroke/action/status tokens, not raw palette
  values or one-off hex colors.
- Maintain primitive, semantic, and component token layers for color,
  typography, spacing, sizing, radius, elevation, motion, content width, and
  z-index. Ordinary feature layout must not use raw colors or arbitrary inline
  style constants.
- The current brand primary is teal (`#159DB8`), with Satoshi typography and
  Console App's light/dark surface system. These values belong in tokens, never
  repeated across feature components.
- Auth pages should follow Console App's auth shell and field treatment while
  simplifying operator-oriented density for an end-user audience.
- Inventory is mobile-first and visual. Maintain useful desktop density without
  making phone users navigate an admin table.
- Support light and dark themes only through semantic variables. Verify focus,
  hover, disabled, error, and status contrast in both themes.
- Maintain semantic HTML, visible labels, keyboard access, focus restoration,
  sufficient contrast, reduced-motion behavior, and useful loading/error/empty
  states. Do not rely on color alone for action-log status.
- Target WCAG 2.2 AA. Feature code does not hand-roll dialogs, menus, tabs,
  comboboxes, tooltips, or focus traps; use reviewed design-system primitives
  implementing the complete keyboard, focus, and ARIA pattern.

## Generated SDK and API Contract

- `../api-v3/api.yaml` is the canonical HTTP contract. `../web-sdk` is its
  generated TypeScript representation. Backend implementation details do not
  override the reviewed contract silently.
- Never manually edit files under `api/web-sdk/` or in the sibling generated
  `../web-sdk` repository as part of the wallet feature work.
- `npm run sdk:sync` must copy the reviewed sibling SDK into `api/web-sdk/`,
  normalize only deterministic integration concerns, and record the source
  commit. Do not hand-copy individual generated models or API methods.
- After a canonical API change:
  1. Validate and bundle the OpenAPI document in `../api-v3`.
  2. Regenerate and review `../web-sdk`.
  3. Run `npm run sdk:sync` in the wallet.
  4. Update the wallet adapters, field dispositions, and use sites.
  5. Run `npm run check`, `npm run build`, and relevant browser tests.
- Important current generated operations:
  - wallet account: `registerWallet`, `loginWallet`, `getWallet`,
    `updateWallet`, and `deleteWallet`;
  - verification/recovery: `requestVerificationCode`, `verifyWallet`,
    `resetPassword`, `setNewPassword`, and `requestOTPCode` where the product
    flow explicitly needs OTP;
  - EOA: `getAuthChallenge` followed by `connectEoa`;
  - passkey: `passkeyRegisterOptions`, `passkeyRegisterVerify`,
    `passkeyLoginOptions`, and `passkeyLoginVerify`;
  - inventory: `listObjects` and `getObjectById`;
  - activity: `listActionLogs`.
- Keep generated method inputs and JSON field names authoritative. Do not
  compensate for a contract mismatch with guessed aliases or duplicate
  hand-written `fetch` wrappers.
- Generated dates, decimal strings, nullable fields, and unions are normalized
  once in adapters. Preserve the original values when display conversion could
  lose precision or meaning.
- Cursor pagination uses the API's `next` token. Never treat it as an offset,
  synthesize page numbers that imply random access, or drop it during filters.

## Authentication and Account Workflows

- Email/password is the default tab, route focus, and keyboard order on login
  and registration. Remembering another method may be a user preference, but it
  must not make email unavailable or silently trigger a wallet prompt.
- Email registration uses `registerWallet`; login uses `loginWallet`. Keep
  registration, verification, and authenticated-session success as distinct
  states even if the API returns a session during registration.
- Verification uses `requestVerificationCode` and `verifyWallet`. Preserve the
  email/phone identifier and organization context deliberately; never infer a
  successful verification from navigation alone.
- Forgot-password uses `resetPassword` to request recovery and
  `setNewPassword` to consume the delivered token. Do not reveal whether an
  account exists, log recovery tokens, or place tokens in analytics.
- EOA flow:
  1. Request a fresh, single-use challenge immediately before signing.
  2. Ask the connected wallet to sign the exact challenge with
     `personal_sign` through the reviewed connector.
  3. Send the challenge/signature to `connectEoa` through the dedicated session
     BFF route.
  4. Never request, receive, persist, or transmit the EOA private key.
- Passkey registration and login must use the option objects issued by
  `api-v3`, convert base64url/binary fields at one reviewed browser boundary,
  call `navigator.credentials.create` or `navigator.credentials.get`, and send
  the resulting credential to the matching verify operation.
- Treat WebAuthn cancellation, unsupported browsers, invalid RP/origin,
  expired challenges, and duplicate credentials as distinct user-recoverable
  outcomes where the API provides that distinction.
- Do not reuse a challenge, cache one for later, replace server-issued WebAuthn
  options, or implement custom signature verification in the browser.
- Account settings display `getWallet` data and submit only supported
  `WalletUpdate` fields. Destructive deletion requires a clear consequence
  explanation, typed/explicit confirmation, and session cleanup on success.

## Session and BFF Security Invariants

- Browser JavaScript must never read access or refresh tokens. Do not use
  `localStorage`, `sessionStorage`, IndexedDB, readable cookies, URLs, or React
  state for API credentials.
- The browser stores one host-only, HttpOnly, SameSite=Strict opaque session
  cookie. Production uses the `__Host-` prefix and `Secure`.
- Access and refresh JWTs remain in the Next.js server process, keyed by a hash
  of the opaque session credential. Never serialize them into props, RSC
  payloads, logs, errors, or client query caches.
- Preserve single-flight refresh and refresh-token rotation. A rotated refresh
  token replaces the old token atomically; concurrent requests must not race
  the session into logout or reuse.
- Login, registration, verification, recovery, EOA, passkey, refresh, and
  logout use dedicated `app/api/session/*` routes. The generic backend proxy
  must deny `/auth/*`, `/wallets/connect/*`, empty paths, traversal segments,
  and private `/p*` endpoints.
- Proxied mutations validate the exact configured `Origin`. Keep explicit
  method, path, body-size, request-header, and response-header allowlists.
- Authenticated responses are `private, no-store`. A terminal upstream 401
  clears the wallet session; transient API errors do not silently destroy it.
- UI route guards are usability controls, not authorization. The API must
  authorize every wallet, object, action-log, and settings request.
- Preserve strict CSP and security headers. WalletConnect and asset origins
  must be narrow, documented additions rather than broad wildcards.

## Inventory, Objects, Activity, and Settings

Before changing external display selection, iframe behavior, bridge
capabilities, FaceView configuration, or external-face deployment inputs, read
`docs/external-face-integration.md` and the canonical protocol/security
documents it links. Keep that guide synchronized with the code and tests.

- Inventory loads objects accessible to the authenticated wallet with
  `listObjects`. Use the current wallet/account data and canonical API filters;
  do not use organization-wide console queries as a substitute.
- Normalize SmartObject metadata, assets, faces, actions, ownership, hashes,
  timestamps, and chain data into a stable `InventoryItem`/`ObjectDetail`
  domain model. Preserve unknown/custom fields without presenting them as
  trusted UI.
- Object metadata, asset URLs, SVG/HTML-like content, and action labels are
  untrusted remote data. Escape text, validate URL schemes, restrict image
  origins, and sandbox any future rich renderer. Never use unchecked
  `dangerouslySetInnerHTML`.
- A bridge-enabled external face is identified by application ID + semantic
  major + exact origin + URL path prefix. Origin allowlisting alone is not
  sufficient. Verify the child's ready identity before sending context and
  close the channel on mismatch, navigation, timeout, or unmount.
- Keep the external-face bridge host modular: `core/` owns application binding,
  context, protocol validation, errors, and channel transport;
  `capabilities/` owns named operations and injected handlers. A new backend
  integration adds a capability module without teaching transport about the
  use case.
- Inventory
  cards may receive only the reviewed minimized card projection and
  non-privileged card capability; they receive no private/custom fields,
  content or state hashes, signer/session data, private-attribute handler, or
  action-request handler. Only an authenticated detail route may grant
  `object.attributes.read` or `object.action.request` to an explicitly
  configured application path.
- `object.attributes.read` accepts no object ID and maps only to the bound
  object's authenticated attribute GET through the BFF. Return the minimized
  attribute projection; never expose hashes used for write preconditions,
  action IDs, wallet/session fields, or raw upstream errors unless the bridge
  contract explicitly requires them.
- An external action request is untrusted intent, not authorization. Accept
  only a supported action name and known form-default fields, reject child
  object/signer/organization/endpoint values, refetch the object's fresh action
  list, and require the existing wallet-native confirmation and
  email/passkey/EOA execution flow. Allow one pending request per face.
- Never send JWTs, cookies, passkey assertions, challenges, EOA signatures,
  permit secrets, or raw action payloads to an iframe. Do not add generic
  fetch/proxy bridge operations.
- Activity calls `listActionLogs` with the current wallet ID and/or signer as
  defined by the canonical ownership model. Keep the wallet filter across
  cursor pages and filter changes; never expose an organization-wide operator
  feed in the wallet.
- Activity maps status, action name/alias, affected objects, transaction hash,
  timestamps, and fee strings into a user-readable model. Preserve exact fee
  strings and label units; do not imply finality beyond the API status.
- Never render a raw action-log DTO or upstream response. Secondary technical
  disclosure uses an adapted, redacted domain projection and never includes
  signatures, authentication payloads, permit secrets, or raw errors.
- Inventory/object query keys and activity query keys must include every
  filter, wallet identity, and cursor that changes their result.
- Settings invalidates the current-wallet query after successful updates and
  rehydrates the session's safe wallet summary. It never edits cached generated
  DTOs in place.
- Use request IDs from normalized backend errors in support/debug details, but
  do not show tokens, signatures, raw auth bodies, or sensitive upstream data.

## Environment Variables

- Create an untracked `.env.local`; never commit environment files or real
  credentials.
- Server-only:
  - `API_URL`: upstream `api-v3` origin.
  - `VIEWER_BASE_DOMAIN`: parent wallet domain. The left-most tenant subdomain
    is resolved by the server-owned map in `api/tenant.ts` to the organization
    ObjectID injected by the BFF into account operations.
  - `PRODUCT_FACE_APPLICATIONS`: the product-application registry (JSON
    array). Not secret, but never `NEXT_PUBLIC_*`; it is also a build input
    for the exact CSP `frame-src` origins.
  - `FACE_ASSERTION_SIGNING_KEY` and `FACE_ASSERTION_KEY_ID`: the Ed25519
    signer for one-time product-face assertions. Secret; absent or invalid
    fails closed with 503.
  - `TIG_RUNTIME_OIDC_ORIGINS`: default off; exact https runtime origins that
    receive this deployment's Vercel OIDC token on runtime calls
    (`api/runtime-oidc.ts`). Workload authentication only, never holder
    authority; not secret.
  - `WALLET_HOST_CONFIGURATION` and `WALLET_HOST_CONFIGURATION_SHA256`: a
    branded host's canonical configuration and its pin
    (`docs/branded-wallet-hosts.md`). Not secret and also a build input.
    Unset is the generic wallet, unchanged; present but invalid fails closed
    (503 on every page and BFF route). A configured host resolves exactly its
    entrance organisation and origin, never `DEFAULT_ORGANIZATION_ID` or the
    host map.
- Public build-time values only when browser code genuinely needs them:
  - `NEXT_PUBLIC_APP_URL`
  - `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`
  - `NEXT_PUBLIC_EXTERNAL_FACE_BRIDGE_ORIGINS`: exact trusted iframe origins.
  - `NEXT_PUBLIC_EXTERNAL_FACE_BRIDGE_APPLICATIONS`: comma-separated
    `application.id@major=https://origin/path/` bindings used to verify both
    the iframe URL and its bridge-ready identity before initialization.
  - reviewed public chain ID, RPC, and explorer values if EOA UX needs them.
- Tenant hosts use `<tenant-label>.<VIEWER_BASE_DOMAIN>`. Missing or unmapped
  labels use the documented `*` organization mapping. Origin validation
  compares the exact incoming tenant host; do not accept sibling subdomains for
  mutations. Do not introduce a browser-visible upstream API URL when the BFF
  can keep requests same-origin.
- Never put secrets, API keys, session credentials, refresh tokens, private
  RPC credentials, or signer material in `NEXT_PUBLIC_*` values.
- Do not copy undocumented API URLs, organization IDs, WalletConnect project
  IDs, chain endpoints, or contract addresses from the old files. The explicit
  organization map in `api/tenant.ts` is the versioned deployment manifest;
  document every addition or change.

## Testing

- Unit/component tests use Jest and Testing Library; E2E tests use Playwright
  Chromium. Prefer role/label queries and test keyboard/focus behavior.
- During development, run the smallest relevant test first, then `npm run
check`. Run `npm run build` for routes, server/client boundaries, environment,
  SDK synchronization, security headers, or deployment changes.
- Run E2E tests for login, registration, verification, password recovery,
  logout, session refresh, route protection, EOA/passkey browser ceremonies,
  inventory pagination, object details, activity filtering, settings, and
  accessibility-critical flows.
- Mock APIs, wallet connectors, WebAuthn credentials, timers, and query clients
  deterministically. Tests must not call live APIs, send real verification
  messages, open real wallets, access real passkeys, or submit chain writes.
- Add regression coverage for token non-exposure, cookie flags, origin checks,
  proxy deny rules, refresh rotation, challenge expiry/replay, cancelled wallet
  prompts, passkey encoding, current-wallet filtering, cursor preservation,
  unsafe asset URLs, and terminal 401 cleanup.
- External-face changes additionally require application/path/major mismatch,
  unknown envelope fields, duplicate request IDs, message limits, rate limits,
  capability denial, object-ID injection, action cancellation, and real
  cross-origin iframe integration coverage with mocked APIs.
- Test loading, empty, error, partial-data, stale-session, and pagination states
  in addition to the happy path.
- The quality baseline also enforces architecture import boundaries,
  TanStack Query's strict ESLint rules, formatting checks, automated
  accessibility checks, and reviewed viewport/theme visual coverage. Do not
  enable a rule without resolving existing violations or recording an explicit,
  time-bounded migration.

## Documentation and Delivery

- `README.md` is the repository overview; `docs/README.md` is the documentation
  index. Keep both current.
- The focused product, UI/accessibility, architecture/logic, and React/state
  guides live in `docs/development/` and are indexed from `docs/README.md`.
- Document the Next.js architecture and its current deployment.
- Update relevant documentation in the same change when modifying:
  - auth method flows, cookies, refresh, or proxy policy;
  - route ownership or the wallet navigation model;
  - generated SDK synchronization or field dispositions;
  - inventory ownership/filter semantics or activity visibility;
  - design-token provenance and theme behavior; or
  - environment and deployment requirements.
- Keep browser UI state, server session state, wallet connector state, API
  indexed state, and on-chain state explicitly distinct.
- Do not document planned or aspirational behavior as if it is already shipped.
- Never commit tokens, passwords, recovery links, verification codes, wallet
  signatures, passkey assertions, personal data, production credentials,
  `.env*`, build output, Playwright reports, or local test artifacts.
- Do not push commits, publish packages/images, deploy the wallet, change cloud
  resources, or alter production configuration without explicit confirmation.

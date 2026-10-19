# P4 native entrances on a protected backend

Wallet side only. The source and FICTIONAL fixtures are in this repository.
Nothing here is deployed, bound or live.

## The failure (reproduced at db6b884)

The fixture is a fictional branded host with Tickets and Loyalty on two of its
own faces. Both faces are bound to a local fake backend that refuses every
request without the deployment's workload token with 401. Signed in, with the
pinned Ticket face Studio H2 emitted (`3e5ede0`, `src/ticket-face-artifact.mjs`):

- `/products/<slug>`, `/home`, `/support` and `/ended`, for both faces, showed
  no frame, only "This product application is unavailable right now. Try
  again shortly."
- The wallet server's credential-free artifact check (`verifyFaceArtifact`:
  `manifest.json`, `index.html`) reached the backend with no token, and got 401.
- The browser never reached it either: the frame is only mounted after that
  check passes. Loading it directly would also fail, since the browser cannot
  present the token.
- The native Tickets and Loyalty pages already worked. Their runtime calls
  carried the token through `TIG_RUNTIME_OIDC_ORIGINS`.

## The repair

A face is **native-only** on a branded host when it serves Tickets or Loyalty
and backs none of the host's enabled framed journeys (registration, My
products, service progress, quote decisions, transfer). The rule is
`nativeOnlyJourneys` in `api/wallet-host.ts`.

On a native-only face, no frame is rendered (`products/[slug]/layout.tsx`).
Nothing of its artifact is read by the wallet server or loaded by the
browser. Its no-journey routes are wallet pages (`[[...task]]/page.tsx`,
`native-product-entrance.tsx`):

| Route                                            | Native-only face                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `/products/<slug>`, `/products/<slug>/home`      | Redirects to its native journey, `/tickets` or `/loyalty`. A face serving both shows a choice of them. |
| `/products/<slug>/support`                       | Help: the brand's description, where the tickets or membership are kept, links to them and to Home     |
| `/products/<slug>/ended`                         | "This page has closed": nothing is open there; the same links                                          |
| deeper paths under those                         | Back to the entrance                                                                                   |
| a disabled journey's task, another client's face | Not found, unchanged                                                                                   |

These pages read and claim nothing about the holder. Tickets, membership,
benefits and admission stay in the native journeys and their BFF assertions,
journals and proofs. The rule leaves these unchanged:

- the generic wallet;
- every face of a host that enables registration or My products, as P3 hosts
  do;
- any face backing an enabled framed journey.

The context route and `api/face-artifact.ts` are unchanged too. No server
read of the artifact is needed: a native-only face's frame could open nothing.
There is no new trust, proxy, token path, CSP or sandbox change.

## Proof (FICTIONAL)

- `api/host-native-entrance.test.ts`: the rule for the generic wallet, a P3
  host, a Tickets and Loyalty host with multiple own faces, a disabled
  journey, an enabled framed journey, and another client's face.
- `app/(authorized)/products/[slug]/[[...task]]/page.test.tsx`: the rendered
  layout and task page. A native-only face has no frame and gets the
  redirects, the choice, help and end pages; the generic wallet and P3 hosts
  keep the frame and an empty task page. The native cases fail on db6b884's
  layout and page.
- `api/face-artifact.test.ts`: the pinned-fixture test now also verifies the
  committed H2 bytes
  (`e2e/fixtures/p4-ticket-face/fictional.tickets.harbour-nights/…`, kept
  apart from `e2e/fixtures/product-face/` so the product-face suite keeps
  its own pinned face), and
  refuses a one-byte change.
- `npx playwright test -c playwright.p4-entrances.config.ts` runs the real
  wallet against the local fake protected backend, which serves the H2 face
  and forwards to the fake Loyalty runtime. It covers:
  - the premise: every unauthenticated read is 401;
  - each entrance, help and end route, signed out to signed in and back
    (`/login?next=`);
  - Loyalty join and the Tickets list through the real BFFs; runtime calls
    only server-side, with this run's token;
  - disabled journeys and another client's face refused, with no fallback;
  - a phone-width keyboard path: end state, Tickets, brand Home, membership,
    help, Home;
  - a fresh reopen in a new tab.

  Every case checks:
  - no frame;
  - no browser request to the backend;
  - no unauthenticated or artifact request at the backend;
  - no token in any browser request, response, cookie, storage or DOM.

## Remaining live gaps (root)

- None of this is deployed. Both wallet hosts' prepared session/assertion
  keys, `TIG_RUNTIME_OIDC_ORIGINS` for the exact protected backend origin,
  and the three exact-origin configs are root's to install. Then a live
  signed-in walk of each entrance on each host is still needed.
- A framed face (any P3 journey) on a protected backend still cannot load,
  because the browser loads its artifact directly. Supporting that would need
  a new access prerequisite. It is out of scope here.
- The Ticket face Studio H2 emits stays valid as a pinned artifact, but a
  native-only host never shows it. Publishing it changes nothing a customer
  sees on such a host.

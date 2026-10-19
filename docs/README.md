# Wallet documentation

- [Architecture](./architecture.md)
- Development guidelines:
  - [the wallet product guidelines](./development/wallet-product-guidelines.md)
  - [UI and accessibility guidelines](./development/ui-accessibility-guidelines.md)
  - [Architecture and logic guidelines](./development/architecture-logic-guidelines.md)
  - [React and state guidelines](./development/react-state-guidelines.md)
- [External-face integration and change guide](./external-face-integration.md),
  including the product application host (`dual-product-face-v1`, shared
  contract in [`contracts/dual-product-face-v1.json`](../contracts/dual-product-face-v1.json))
- [Dedicated applications, authentication, and shared packages](./dedicated-applications.md)
- [Branded wallet hosts](./branded-wallet-hosts.md): one engine, a separate
  branded deployment per brand configured only by environment
  (`dual-wallet-host-configuration-v1`), journey enforcement, entrance
  isolation, fail-closed mode and readback
- [P4 Tickets wallet handoff](./development/p4-tickets-handoff.md): the
  opt-in read-only Tickets journey, its tests, residual risks and the backend
  and Studio contract it needs
- [P4 Loyalty custody diagnosis](./development/p4-loyalty-diagnosis.md): the
  archived read-only diagnosis (Studio `ff977a4`) behind the opening-pass
  approach, with provider assumptions marked live-unverified
- Specs:
  - [Wallet branding contract](./specs/2026-08-20-wallet-branding-design.md)
- Evidence (development, local fakes only):
  - [Interoperability with Studio's actual generated runtime, 2026-10-16](./evidence/2026-10-16-studio-runtime-interoperability.md):
    the exact version pairs, commands and verbatim results of the settle
    check and the r20 probe against Studio `a2b04b9` (Warranty held) and its
    child `4b20253` (Warranty proved, recovery closed), and the Studio
    dependencies they surfaced
- Proposals (not deployed):
  - [Loyalty join and earn, loyalty-join-earn-v1](./proposals/loyalty-join-earn-v1.md):
    the final native join/earn wire contract on the existing opening pass and
    issuer-owned canonical membership, the wallet's proof rules (implemented
    in source, fixtures only) and the live release blockers
  - [Runtime write outcome, recovery listing and acknowledgement, r20](./proposals/runtime-write-status-r20.md):
    the pinned Studio runtime wire schema the wallet needs to free a journal
    slot from a verified write outcome and to recover unresolved or unseen
    outcomes without a browser cookie

#!/usr/bin/env node
// FICTIONAL Tickets/Home fixture, run persistently for a manual walk:
//   node e2e/tickets-home/serve.mjs
// It starts the local fake API (e2e/mock-api.mjs, MOCK_TICKETS=1) and the
// wallet (next dev) as the fictional "Harbour Nights" branded host, on their
// own ports (TICKETS_FIXTURE_WALLET_PORT, TICKETS_FIXTURE_API_PORT). Nothing
// it uses is real: no Dual, no provider, no released host configuration, and
// the session and signing keys are generated for this process only.
// Ctrl+C stops both.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FICTIONAL_ACCOUNTS,
  fixtureEnvironment,
  ports,
  SLUG,
} from "./environment.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const env = fixtureEnvironment();
const { wallet } = ports();

const children = [
  spawn(process.execPath, ["e2e/mock-api.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env.api },
  }),
  spawn(
    process.execPath,
    [
      path.join(root, "node_modules/next/dist/bin/next"),
      "dev",
      "-p",
      String(wallet),
    ],
    { cwd: root, stdio: "inherit", env: { ...process.env, ...env.wallet } },
  ),
];

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) {
  child.on("exit", (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
}

const { holder, secondHolder } = FICTIONAL_ACCOUNTS;
console.log(`
FICTIONAL Tickets/Home fixture (local fakes only; nothing here is Dual)
  Home:          ${env.origin}/
  Sign in:       ${env.origin}/login
  All tickets:   ${env.origin}/products/${SLUG}/tickets
  Fake API:      ${env.apiOrigin} (health: ${env.apiOrigin}/health)
  Holder:        ${holder.email} / ${holder.password}
  Second holder: ${secondHolder.email} / ${secondHolder.password}
  Fixture modes (local fake only):
    curl -X POST ${env.apiOrigin}/__test__/tickets -d '{"mode":"emptyWithMore"}'
    curl -X POST ${env.apiOrigin}/__test__/tickets -d '{"mode":"unavailable"}'
    curl -X POST ${env.apiOrigin}/__test__/tickets -d '{"expireSessions":true}'
    curl -X POST ${env.apiOrigin}/__test__/tickets -d '{"reset":true}'
`);

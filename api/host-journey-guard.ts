import "server-only";

import type { NextRequest } from "next/server";
import type { FaceJournal } from "@/api/face-journal";
import { MAX_BFF_BODY_BYTES } from "@/api/settings";
import { hostJourneyEnabled, walletHost } from "@/api/wallet-host";
import { FACE_EXECUTION_OPERATION_HEADER } from "@/app/_domain/face-execution";
import { isRuntimeOperation } from "@/app/_domain/product-face";
import {
  journeyOfJournalEntry,
  journeyOfOperation,
  type HostJourney,
} from "@/app/_domain/wallet-host";

/**
 * The face BFF routes that name themselves to resolveFaceRequest. The
 * identity comes from the route module that serves the request, never from
 * the request path, so no rewrite or prefix can change it.
 */
export type FaceRoute =
  | "context"
  | "selection"
  | "units"
  /** The selected product's public history: a shared read. */
  | "history"
  | "settle-proposal"
  | "transfer-proposal"
  | "transfer-progress"
  | "accept-offer"
  /** The Tickets journey's read-only list and detail (P4.2). */
  | "tickets"
  /** A face's holder-signed step through /api/backend (contract r18). */
  | "execution"
  /**
   * The host's durable recovery listing and acknowledgement (proposed r20).
   * Shared here: each listed item is gated by its own journey in the
   * recovery module, and an acknowledgement re-checks that journey.
   */
  | "recovery"
  | "recovery-ack";

type Classification =
  | { kind: "shared" }
  | { kind: "journey"; journey: HostJourney }
  | { kind: "unclassified" };

const SHARED: Classification = { kind: "shared" };
const UNCLASSIFIED: Classification = { kind: "unclassified" };
const journey = (value: HostJourney): Classification => ({
  kind: "journey",
  journey: value,
});
const ofEntry = (entry: { kind: string; operation?: string } | undefined) => {
  const value = entry ? journeyOfJournalEntry(entry) : undefined;
  return value ? journey(value) : UNCLASSIFIED;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The JSON body, read from a clone so the route still reads its own. */
async function peekBody(request: NextRequest) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BFF_BODY_BYTES) return;
  try {
    const body = await request.clone().arrayBuffer();
    if (body.byteLength > MAX_BFF_BODY_BYTES) return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return record(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The routes that name no identity (the assertion and journal routes) are
 * recognised only at their exact canonical path for the slug they were
 * resolved with. Anything else, an entry-link prefix or an encoded segment
 * included, is not one of them.
 */
function unnamedRoute(request: NextRequest, slug: string) {
  const base = `/api/faces/${slug}`;
  const path = request.nextUrl.pathname;
  if (path === `${base}/assertions`) return { route: "assertions" as const };
  if (path === `${base}/operations`) return { route: "operations" as const };
  const prefix = `${base}/operations/`;
  const rest = path.startsWith(prefix) ? path.slice(prefix.length) : "";
  if (rest && !rest.includes("/")) {
    try {
      return {
        route: "operation-status" as const,
        operationId: decodeURIComponent(rest),
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The journey one face BFF request serves: from the route that names itself,
 * or, for the assertion and journal routes, from their canonical path and the
 * operation or journal entry the request carries. Context, selection and the
 * journal list are shared. Anything else is unclassified.
 */
export async function classifyFaceRequest(
  request: NextRequest,
  slug: string,
  journal: FaceJournal,
  route?: FaceRoute,
): Promise<Classification> {
  const find = (operationId: unknown) =>
    journal.entries.find((item) => item.operationId === operationId);
  switch (route) {
    case "context":
    case "selection":
    case "recovery":
    case "recovery-ack":
    case "history":
      return SHARED;
    case "units":
    case "settle-proposal":
      return journey("registration");
    case "tickets":
      return journey("tickets");
    case "transfer-proposal":
    case "transfer-progress":
    case "accept-offer":
      return journey("transfer");
    case "execution": {
      // The bound journal entry's kind: a settle step is registration's, a
      // transfer step transfer's. No such entry: not a face step at all.
      const entry = find(request.headers.get(FACE_EXECUTION_OPERATION_HEADER));
      return entry && (entry.kind === "settle" || entry.kind === "transfer")
        ? ofEntry(entry)
        : UNCLASSIFIED;
    }
    case undefined:
      break;
  }
  const unnamed = unnamedRoute(request, slug);
  if (!unnamed) return UNCLASSIFIED;
  if (unnamed.route === "operation-status") {
    if (request.method !== "GET") return UNCLASSIFIED;
    const entry = find(unnamed.operationId);
    // Not this launch's own: only ever a recovered registration.
    return entry ? ofEntry(entry) : journey("registration");
  }
  if (unnamed.route === "operations" && request.method === "GET") {
    return SHARED;
  }
  if (request.method !== "POST") return UNCLASSIFIED;
  const body = await peekBody(request);
  if (!body) return UNCLASSIFIED;
  if (unnamed.route === "assertions") {
    return isRuntimeOperation(body.operation)
      ? journey(journeyOfOperation(body.operation))
      : UNCLASSIFIED;
  }
  if (body.transition === "begin") {
    if (body.kind === "runtime") {
      return isRuntimeOperation(body.operation)
        ? journey(journeyOfOperation(body.operation))
        : UNCLASSIFIED;
    }
    return typeof body.kind === "string"
      ? ofEntry({ kind: body.kind })
      : UNCLASSIFIED;
  }
  return ofEntry(find(body.operation_id));
}

/**
 * Whether a branded host refuses this face request: it fails closed, so a
 * request whose route and journey cannot be classified is refused, and so is
 * one whose journey is disabled. Called once, from resolveFaceRequest, before
 * any route logic runs: nothing is journaled, read from a runtime, minted or
 * executed for it. The generic wallet enables every journey and never reads
 * the request here.
 */
export async function faceJourneyRefused(
  request: NextRequest,
  slug: string,
  journal: FaceJournal,
  route?: FaceRoute,
) {
  if (walletHost().status !== "active") return false;
  const classification = await classifyFaceRequest(
    request,
    slug,
    journal,
    route,
  );
  if (classification.kind === "shared") return false;
  if (classification.kind === "unclassified") return true;
  return !hostJourneyEnabled(classification.journey);
}

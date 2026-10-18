import "server-only";

import type { FaceRequestContext } from "@/api/product-face-server";
import { ResponseError } from "@/api/web-sdk/runtime";
import { getObjectsApi } from "@/api/web-sdk-client";
import { toTicketSource } from "@/app/_adapters/tickets";
import {
  decodeTicketCursor,
  encodeTicketCursor,
  evaluateTicket,
  type Ticket,
  type TicketPage,
  type TicketRefusal,
  type TicketRules,
} from "@/app/_domain/tickets";

const PAGE_SIZE = 25;
/** Upstream list reads one Tickets request may make. */
export const MAX_UPSTREAM_READS = 4;
/** The longest upstream continuation a ticket cursor can carry back. */
const MAX_UPSTREAM_NEXT = 300;

/** Upstream paging that cannot make progress: a failure, never "none". */
class UpstreamPagingError extends Error {}

export type TicketReadFailure =
  TicketRefusal | "invalid_request" | "not_found" | "session_expired";

export type TicketListResult =
  | { ok: true; page: TicketPage }
  | { ok: false; code: "invalid_request" | "session_expired" };

export type TicketReadResult =
  { ok: true; ticket: Ticket } | { ok: false; code: TicketReadFailure };

function status(error: unknown) {
  return error instanceof ResponseError ? error.response.status : undefined;
}

/** The binding's ticket rules; a face without them serves no Tickets. */
export function ticketRules(context: FaceRequestContext): TicketRules | null {
  return context.binding.tickets;
}

function evaluation(context: FaceRequestContext, rules: TicketRules) {
  return {
    holder: context.holder,
    // The client is the organisation the session is bound to, which on a
    // branded host is exactly its entrance organisation.
    clientId: context.state.organizationId,
    templateIds: context.binding.templateIds,
    rules,
  };
}

/**
 * One page of the signed-in holder's own tickets. The upstream list is
 * filtered by owner and template (never organisation-wide), and every object
 * is checked again: only an object the current holder owns, issued by this
 * client, from a programme template, is listed.
 */
export async function listTickets(
  context: FaceRequestContext,
  rules: TicketRules,
  cursor: string | undefined,
): Promise<TicketListResult> {
  const templates = context.binding.templateIds;
  let position = { templateIndex: 0 } as {
    templateIndex: number;
    next?: string;
  };
  if (cursor !== undefined) {
    const decoded = decodeTicketCursor(cursor, templates.length);
    if (!decoded) return { ok: false, code: "invalid_request" };
    position = decoded;
  }
  const api = getObjectsApi(context.state.accessToken);
  // Upstream continuations already followed in this request (the one it
  // started from included): one that comes back can never terminate.
  const followed = new Set<string>();
  if (position.next) followed.add(`${position.templateIndex}:${position.next}`);
  for (let reads = 0; position.templateIndex < templates.length; reads += 1) {
    // Bounded work per request: every read so far found nothing, so the
    // holder gets a continuation to check further, never "no tickets".
    if (reads === MAX_UPSTREAM_READS) {
      return {
        ok: true,
        page: { tickets: [], next: encodeTicketCursor(position) },
      };
    }
    const templateId = templates[position.templateIndex];
    let result;
    try {
      result = await api.listObjects(
        {
          owner: context.holder,
          templateId,
          limit: PAGE_SIZE,
          next: position.next,
          order: "desc",
          sortBy: "when_modified",
        },
        { cache: "no-store" },
      );
    } catch (error) {
      if (status(error) === 401) return { ok: false, code: "session_expired" };
      throw error;
    }
    const tickets: Ticket[] = [];
    for (const object of result.objects) {
      const evaluated = evaluateTicket(
        toTicketSource(object),
        evaluation(context, rules),
      );
      if (evaluated.ok) tickets.push(evaluated.ticket);
    }
    if (result.next) {
      if (
        result.next.length > MAX_UPSTREAM_NEXT ||
        followed.has(`${position.templateIndex}:${result.next}`)
      ) {
        throw new UpstreamPagingError();
      }
      followed.add(`${position.templateIndex}:${result.next}`);
    }
    const following = result.next
      ? { templateIndex: position.templateIndex, next: result.next }
      : { templateIndex: position.templateIndex + 1 };
    const done = following.templateIndex >= templates.length;
    // An empty page that is not the last continues to the next template, so
    // "no tickets" is only ever said once every template was read.
    if (tickets.length || done) {
      return {
        ok: true,
        page: {
          tickets,
          next: done ? null : encodeTicketCursor(following),
        },
      };
    }
    position = following;
  }
  return { ok: true, page: { tickets: [], next: null } };
}

/** One ticket, re-read with the session's own credential. */
export async function readTicket(
  context: FaceRequestContext,
  rules: TicketRules,
  objectId: string,
): Promise<TicketReadResult> {
  let source;
  try {
    source = toTicketSource(
      await getObjectsApi(context.state.accessToken).getObjectById(
        { objectId },
        { cache: "no-store" },
      ),
    );
  } catch (error) {
    const code = status(error);
    if (code === 401) return { ok: false, code: "session_expired" };
    if (code === 403 || code === 404) return { ok: false, code: "not_found" };
    throw error;
  }
  if (source.objectId !== objectId) return { ok: false, code: "not_found" };
  const evaluated = evaluateTicket(source, evaluation(context, rules));
  return evaluated.ok
    ? { ok: true, ticket: evaluated.ticket }
    : { ok: false, code: evaluated.refusal };
}

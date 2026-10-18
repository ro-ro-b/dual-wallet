import "client-only";

import {
  parseTicket,
  parseTicketPage,
  type Ticket,
  type TicketPage,
} from "@/app/_domain/tickets";

/** The Tickets BFF failures a page distinguishes (anything else: unavailable). */
export type TicketsFailure =
  "session_expired" | "not_found" | "capability_not_granted" | "unavailable";

export class TicketsError extends Error {
  constructor(readonly failure: TicketsFailure) {
    super(failure);
    this.name = "TicketsError";
  }
}

function failureOf(code: string): TicketsFailure {
  switch (code) {
    case "session_expired":
    case "not_found":
    case "capability_not_granted":
      return code;
    default:
      return "unavailable";
  }
}

async function ticketsRequest(
  slug: string,
  launchId: string,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/faces/${encodeURIComponent(slug)}${path}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      signal,
      headers: { Accept: "application/json", "x-dual-face-launch": launchId },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TicketsError("unavailable");
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code =
      body && typeof body === "object" && "code" in body
        ? String((body as { code: unknown }).code)
        : "";
    throw new TicketsError(
      response.status === 401 ? "session_expired" : failureOf(code),
    );
  }
  return body;
}

/** One page of the signed-in holder's own tickets. */
export async function listTicketsPage({
  slug,
  launchId,
  cursor,
  signal,
}: {
  slug: string;
  launchId: string;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<TicketPage> {
  const query = cursor ? `?next=${encodeURIComponent(cursor)}` : "";
  const page = parseTicketPage(
    await ticketsRequest(slug, launchId, `/tickets${query}`, signal),
  );
  if (!page) throw new TicketsError("unavailable");
  return page;
}

/** One ticket; the server re-reads it and refuses any that is not theirs. */
export async function getTicket({
  slug,
  launchId,
  objectId,
  signal,
}: {
  slug: string;
  launchId: string;
  objectId: string;
  signal?: AbortSignal;
}): Promise<Ticket> {
  const body = await ticketsRequest(
    slug,
    launchId,
    `/tickets/${encodeURIComponent(objectId)}`,
    signal,
  );
  const ticket =
    body && typeof body === "object" && "ticket" in body
      ? parseTicket((body as { ticket: unknown }).ticket)
      : undefined;
  // A different object than the one asked for is never shown as it.
  if (!ticket || ticket.objectId !== objectId) {
    throw new TicketsError("unavailable");
  }
  return ticket;
}

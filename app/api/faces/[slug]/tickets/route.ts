import type { NextRequest } from "next/server";
import {
  faceContextError,
  faceResponse,
  resolveFaceRequest,
} from "@/api/product-face-server";
import { listTickets, ticketRules } from "@/api/product-face-tickets";
import { ticketsServedBy } from "@/api/wallet-host";
import type { TicketPage } from "@/app/_domain/tickets";

type Params = { params: Promise<{ slug: string }> };

// The signed-in holder's own tickets, read-only. The holder, client and
// programme come from the session and the server registry; the request names
// only an opaque continuation.
export async function GET(request: NextRequest, { params }: Params) {
  const { slug } = await params;
  const context = await resolveFaceRequest(request, slug, {
    route: "tickets",
  });
  if (!("binding" in context)) return context;
  const rules = ticketRules(context);
  if (!rules || !ticketsServedBy(context.binding)) {
    return faceContextError(context, "capability_not_granted", 403);
  }
  const url = request.nextUrl;
  const queryKeys = Array.from(url.searchParams.keys());
  const next = url.searchParams.get("next") ?? undefined;
  if (
    queryKeys.some((key) => key !== "next") ||
    url.searchParams.getAll("next").length > 1
  ) {
    return faceContextError(context, "invalid_request", 400);
  }
  try {
    const result = await listTickets(context, rules, next);
    if (!result.ok) {
      return faceContextError(
        context,
        result.code,
        result.code === "session_expired" ? 401 : 400,
      );
    }
    const page: TicketPage = result.page;
    return faceResponse(context, page);
  } catch {
    return faceContextError(context, "upstream_unavailable", 502);
  }
}

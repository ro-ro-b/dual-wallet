import type { NextRequest } from "next/server";
import {
  faceContextError,
  faceResponse,
  resolveFaceRequest,
} from "@/api/product-face-server";
import { readTicket, ticketRules } from "@/api/product-face-tickets";
import { ticketsServedBy } from "@/api/wallet-host";
import { isObjectId } from "@/app/_domain/product-face";

type Params = { params: Promise<{ slug: string; objectId: string }> };

// One ticket of the signed-in holder, re-read for this request. A ticket of
// another holder, client or programme answers the same not_found as a
// missing one, so the route confirms nothing about objects that are not the
// holder's.
export async function GET(request: NextRequest, { params }: Params) {
  const { slug, objectId } = await params;
  const context = await resolveFaceRequest(request, slug, {
    route: "tickets",
  });
  if (!("binding" in context)) return context;
  const rules = ticketRules(context);
  if (!rules || !ticketsServedBy(context.binding)) {
    return faceContextError(context, "capability_not_granted", 403);
  }
  if (!isObjectId(objectId) || request.nextUrl.search) {
    return faceContextError(context, "invalid_request", 400);
  }
  try {
    const result = await readTicket(context, rules, objectId);
    if (!result.ok) {
      if (result.code === "session_expired") {
        return faceContextError(context, "session_expired", 401);
      }
      return faceContextError(context, "not_found", 404);
    }
    return faceResponse(context, { ticket: result.ticket });
  } catch {
    return faceContextError(context, "upstream_unavailable", 502);
  }
}

import type { NextRequest } from "next/server";
import { readJsonRecord } from "@/api/request";
import {
  readMembershipView,
  readProgramme,
  requestJoin,
  submissionStatus,
  submitActivity,
} from "@/api/product-face-loyalty";
import {
  faceContextError,
  faceResponse,
  resolveFaceRequest,
} from "@/api/product-face-server";

type Params = { params: Promise<{ slug: string }> };

const KEYS = [
  "transition",
  "consent",
  "activity_type",
  "evidence_ref",
  "operation_id",
];

// loyalty-join-earn-v1: the native Loyalty page's steps. The holder, wallet,
// binding, programme and runtime come from the session and the server
// registry; the body names only the step, the consent the member gave, the
// activity they report, or one of their own operation ids.
export async function POST(request: NextRequest, { params }: Params) {
  const { slug } = await params;
  const context = await resolveFaceRequest(request, slug, {
    mutation: true,
    journals: true,
    route: "loyalty",
  });
  if (!("binding" in context)) return context;
  const body = await readJsonRecord(request);
  if (
    !body ||
    request.nextUrl.search ||
    Object.keys(body).some((key) => !KEYS.includes(key))
  ) {
    return faceContextError(context, "invalid_request", 400);
  }
  try {
    const result = await (async () => {
      switch (body.transition) {
        case "programme":
          return readProgramme(context);
        case "join":
          return requestJoin(context, body.consent);
        case "membership":
          return readMembershipView(context);
        case "submit":
          return submitActivity(context, body.activity_type, body.evidence_ref);
        case "status":
          return submissionStatus(context, body.operation_id);
        default:
          return undefined;
      }
    })();
    if (!result) return faceContextError(context, "invalid_request", 400);
    const { ok, journal, ...rest } = result;
    if (!ok) {
      const { code, status } = rest as { code: string; status: number };
      return faceResponse(context, { code }, { status, journal });
    }
    return faceResponse(context, rest, { journal });
  } catch {
    return faceContextError(context, "upstream_unavailable", 502);
  }
}

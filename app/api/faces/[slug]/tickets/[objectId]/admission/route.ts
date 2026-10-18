import type { NextRequest } from "next/server";
import { readJsonRecord } from "@/api/request";
import {
  admissionStatus,
  beginAdmission,
  cancelAdmission,
  checkAdmission,
  confirmAdmission,
  readPass,
  recordAndVerifyAdmission,
} from "@/api/product-face-admission";
import {
  faceContextError,
  faceResponse,
  resolveFaceRequest,
} from "@/api/product-face-server";
import { isObjectId } from "@/app/_domain/product-face";

type Params = { params: Promise<{ slug: string; objectId: string }> };

const KEYS = ["transition", "operation_id", "request_id", "action_id"];

// P4.3 ticket-admission-v1: the native ticket page's entry steps. The holder,
// wallet, binding and runtime come from the session and the server registry;
// the body names only the step and the ids the runtime issued.
export async function POST(request: NextRequest, { params }: Params) {
  const { slug, objectId } = await params;
  const context = await resolveFaceRequest(request, slug, {
    mutation: true,
    journals: true,
    route: "tickets",
  });
  if (!("binding" in context)) return context;
  const body = await readJsonRecord(request);
  if (
    !body ||
    !isObjectId(objectId) ||
    request.nextUrl.search ||
    Object.keys(body).some((key) => !KEYS.includes(key))
  ) {
    return faceContextError(context, "invalid_request", 400);
  }
  try {
    const result = await (async () => {
      switch (body.transition) {
        case "check":
          return checkAdmission(context, request, objectId);
        case "pass":
          return readPass(context, request, objectId);
        case "begin":
          return beginAdmission(context, request, objectId, body.request_id);
        case "cancel":
          return cancelAdmission(context, body.operation_id);
        case "confirm":
          return confirmAdmission(context, request, body.operation_id);
        case "record_action":
          return recordAndVerifyAdmission(
            context,
            request,
            body.operation_id,
            body.action_id,
          );
        case "status":
          return admissionStatus(context, request, body.operation_id);
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

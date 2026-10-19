import "server-only";

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import type { NextRequest } from "next/server";
import type { ProductFaceBinding } from "@/api/product-face-binding";
import type { RuntimeOperation } from "@/app/_domain/product-face";
import type { LoyaltyHostOperation } from "@/app/_domain/loyalty";
import type { TicketHostOperation } from "@/app/_domain/ticket-admission";

export const ASSERTION_TYPE = "dual-face-assertion+jwt";
export const ASSERTION_LIFETIME_SECONDS = 60;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

interface Signer {
  kid: string;
  key: KeyObject;
}

let cachedSigner: { source: string; signer: Signer | undefined } | undefined;

function privateKey(value: string): KeyObject | undefined {
  const candidates: Array<() => KeyObject> = [];
  const text = value.replace(/\\n/g, "\n").trim();
  if (text.includes("-----BEGIN")) {
    candidates.push(() => createPrivateKey({ key: text, format: "pem" }));
  } else {
    const decoded = Buffer.from(text, "base64");
    const asText = decoded.toString("utf8");
    if (asText.includes("-----BEGIN")) {
      candidates.push(() => createPrivateKey({ key: asText, format: "pem" }));
    }
    candidates.push(() =>
      createPrivateKey({ key: decoded, format: "der", type: "pkcs8" }),
    );
  }
  for (const candidate of candidates) {
    try {
      const key = candidate();
      if (key.asymmetricKeyType === "ed25519") return key;
    } catch {
      // Try the next accepted encoding.
    }
  }
  return undefined;
}

/**
 * The Ed25519 key and key ID that sign product-face assertions. Absent or
 * invalid configuration returns undefined, and every caller fails closed with
 * `face_assertion_unprovisioned`. The key never leaves this module.
 */
export function faceAssertionSigner(): Signer | undefined {
  const keyValue = process.env.FACE_ASSERTION_SIGNING_KEY ?? "";
  const kid = process.env.FACE_ASSERTION_KEY_ID ?? "";
  const source = `${kid}\u0000${keyValue}`;
  if (cachedSigner?.source === source) return cachedSigner.signer;
  const key = keyValue ? privateKey(keyValue) : undefined;
  const signer = key && KEY_ID.test(kid) ? { kid, key } : undefined;
  cachedSigner = { source, signer };
  return signer;
}

/**
 * The PUBLIC half of the validated signer, for the host's readback: its key ID
 * and its Ed25519 public key as SPKI PEM, derived from the signing key itself
 * (never from another variable or a caller). Undefined when the signer is
 * absent or invalid.
 */
export function faceAssertionPublicKey():
  { kid: string; publicKey: string } | undefined {
  const signer = faceAssertionSigner();
  if (!signer) return undefined;
  const publicKey = createPublicKey(signer.key)
    .export({ type: "spki", format: "pem" })
    .toString();
  return { kid: signer.kid, publicKey };
}

export function sha256Hash(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export interface AssertionTarget {
  /** loyalty-join-earn-v1: the programme's catalog model id. */
  model_id?: string;
  object_id?: string;
  case_id?: string;
  quote_version?: number;
  amount?: string;
  currency?: string;
}

export interface FaceAssertionInput {
  issuer: string;
  binding: ProductFaceBinding;
  walletId: string;
  holder: string;
  /**
   * A face runtime operation, or one of the host's own ticket (P4.3) or
   * Loyalty (loyalty-join-earn-v1) operations.
   */
  operation: RuntimeOperation | TicketHostOperation | LoyaltyHostOperation;
  operationId: string;
  target: AssertionTarget;
  requestHash: string;
  sidHash: string;
  /**
   * contract r10: for case operations, the linked Warranty runtime. Only the
   * audience changes; every other claim (the FACE artifact included) stays.
   */
  audience?: { applicationId: string; origin: string };
  now?: number;
}

const base64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

/**
 * Compact JWS (EdDSA) bound to one runtime operation, target and request.
 * Claims come only from the server-resolved binding and the server-read
 * session; nothing the face or browser supplies names the holder or wallet.
 */
export function mintFaceAssertion(input: FaceAssertionInput) {
  const signer = faceAssertionSigner();
  if (!signer) return undefined;
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const header = { alg: "EdDSA", typ: ASSERTION_TYPE, kid: signer.kid };
  const claims = {
    iss: input.issuer,
    aud: input.audience
      ? `${input.audience.applicationId}@${input.audience.origin}`
      : `${input.binding.applicationId}@${input.binding.origin}`,
    app_id: input.binding.applicationId,
    app_version: input.binding.version,
    artifact: input.binding.artifactHash,
    publisher: input.binding.publisher,
    programme: input.binding.programmeId,
    origin: input.binding.origin,
    sub: input.walletId,
    // The canonical lowercase 0x address. Dual returns the account address as
    // written (EIP-55 mixed case); the runtimes compare and store holders in
    // lowercase, and their assertion check accepts only that form.
    holder: input.holder.toLowerCase(),
    operation: input.operation,
    op_id: input.operationId,
    target: input.target,
    request_hash: input.requestHash,
    sid_hash: input.sidHash,
    iat,
    exp: iat + ASSERTION_LIFETIME_SECONDS,
    jti: randomBytes(18).toString("base64url"),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claims),
  )}`;
  const signature = sign(null, Buffer.from(signingInput), signer.key);
  return {
    assertion: `${signingInput}.${base64url(signature)}`,
    expiresAt: claims.exp * 1000,
  };
}

/**
 * The exact wallet tenant origin. Production is HTTPS only; a present Origin
 * header must match it exactly.
 */
export function walletIssuerOrigin(request: NextRequest) {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = (forwardedHost || request.headers.get("host") || "")
    .split(",", 1)[0]
    .trim()
    .toLowerCase();
  if (!host || /[^a-z0-9.:[\]-]/.test(host)) return undefined;
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    .trim()
    .toLowerCase();
  const protocol =
    process.env.NODE_ENV === "production"
      ? "https:"
      : forwardedProto === "https" || forwardedProto === "http"
        ? `${forwardedProto}:`
        : request.nextUrl.protocol;
  const issuer = `${protocol}//${host}`;
  const origin = request.headers.get("origin");
  if (origin && origin !== issuer) return undefined;
  return issuer;
}

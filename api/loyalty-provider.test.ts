/**
 * @jest-environment node
 */
// loyalty-join-earn-v1 §5: the holder's own pass read (ownPass) against a
// mocked SDK. An exact id read; only an exact empty or not-found answer says
// the pass is not held yet. FICTIONAL ids only.
import { ResponseError } from "@/api/web-sdk/runtime";

const listObjects = jest.fn();
jest.mock("@/api/web-sdk-client", () => ({
  getObjectsApi: () => ({ listObjects }),
  getEbusApi: () => ({}),
}));

import { ownPass } from "@/api/loyalty-provider";

const HOLDER = "0xAbCdEf0000000000000000000000000000000001";
const TEMPLATE = "6c0000000000000000000002";
const PASS = "6c00000000000000000000d1";
const pass = (overrides: Record<string, unknown> = {}) => ({
  id: PASS,
  templateId: TEMPLATE,
  owner: HOLDER.toLowerCase(),
  orgId: "6b0000000000000000000001",
  custom: { schema: "participant-opening-pass-v1" },
  ...overrides,
});
const failure = (status: number) =>
  new ResponseError(new Response(null, { status }), "fictional");
const read = () => ownPass("token", HOLDER, TEMPLATE, PASS);

beforeEach(() => listObjects.mockReset());

describe("ownPass", () => {
  it("asks for exactly the named object, by owner and template, not an inventory page", async () => {
    listObjects.mockResolvedValue({ objects: [pass()] });
    expect(await read()).toEqual({
      ok: true,
      pass: expect.objectContaining({ id: PASS, owner: HOLDER.toLowerCase() }),
    });
    expect(listObjects).toHaveBeenCalledWith(
      { id: PASS, owner: HOLDER, templateId: TEMPLATE, limit: 2 },
      { cache: "no-store" },
    );
  });

  it("an exact empty answer or a not-found id is not held (yet)", async () => {
    listObjects.mockResolvedValue({ objects: [] });
    expect(await read()).toEqual({ ok: true, pass: undefined });
    listObjects.mockRejectedValue(failure(404));
    expect(await read()).toEqual({ ok: true, pass: undefined });
  });

  it("a 401 is an expired session", async () => {
    listObjects.mockRejectedValue(failure(401));
    expect(await read()).toEqual({ ok: false, code: "session_expired" });
  });

  it.each([
    ["a 503", () => listObjects.mockRejectedValue(failure(503))],
    ["a 403", () => listObjects.mockRejectedValue(failure(403))],
    ["a network failure", () => listObjects.mockRejectedValue(new TypeError())],
    ["a body without objects", () => listObjects.mockResolvedValue({})],
    [
      "two objects for one id",
      () => listObjects.mockResolvedValue({ objects: [pass(), pass()] }),
    ],
    [
      "another object",
      () =>
        listObjects.mockResolvedValue({
          objects: [pass({ id: "6c00000000000000000000d2" })],
        }),
    ],
    [
      "another owner",
      () =>
        listObjects.mockResolvedValue({
          objects: [
            pass({ owner: "0x00000000000000000000000000000000000000f9" }),
          ],
        }),
    ],
    [
      "another template",
      () =>
        listObjects.mockResolvedValue({
          objects: [pass({ templateId: "6c0000000000000000000009" })],
        }),
    ],
  ])("%s is unavailable: it claims no absence", async (_label, arrange) => {
    arrange();
    expect(await read()).toEqual({ ok: false, code: "unavailable" });
  });
});

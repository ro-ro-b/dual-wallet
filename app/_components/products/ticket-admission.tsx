"use client";

import { useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Alert } from "@/app/_components/design-system/alert";
import { Button } from "@/app/_components/design-system/button";
import { ModalDialog } from "@/app/_components/design-system/modal-dialog";
import type {
  AdmissionConfirmation,
  AdmissionState,
  TicketPass,
} from "@/app/_domain/ticket-admission";
import {
  executorIdentityOf,
  faceExecutionOf,
  type ExecutorIdentity,
} from "@/app/_lib/external-face-bridge/core/executor-identity";
import { useSession } from "@/app/_providers/session-provider";
import {
  AdmissionError,
  admissionStatus,
  beginAdmission,
  cancelAdmission,
  checkAdmission,
  confirmAdmission,
  executeAdmission,
  readTicketPass,
  recordAdmission,
} from "@/app/_services/ticket-admission.client";

// P4.3 ticket-admission-v1 on the native ticket page. The holder's own
// "Check for entry request" is the only fetch (no polling). Confirmation is
// native and shows server-read facts; nothing is sent until Confirm, and once
// the reservation is won the attempt is only ever read back under its
// original operation: never signed, reserved or sent again.

type View =
  | { kind: "idle" }
  | { kind: "busy"; step: "checking" | "reviewing" | "statusChecking" }
  | { kind: "state"; state: AdmissionState }
  | {
      kind: "confirm";
      confirmation: AdmissionConfirmation;
      custom: Record<string, unknown>;
    }
  | {
      kind: "sending";
      step: "reserving" | "signing" | "verifying";
      operationId: string;
    }
  | { kind: "failed"; code: string };

const FAILURES = [
  "admission_request_expired",
  "admission_request_mismatch",
  "proposal_rejected",
  "admission_unsupported",
  "admission_in_progress",
  "capability_not_granted",
  "session_expired",
  "not_found",
];

const failureOf = (error: unknown) =>
  error instanceof AdmissionError && FAILURES.includes(error.code)
    ? error.code
    : "unavailable";

export function TicketAdmission({
  slug,
  objectId,
  launchId,
}: {
  slug: string;
  objectId: string;
  launchId: string;
}) {
  const t = useTranslations("tickets.admission");
  const format = useFormatter();
  const session = useSession();
  const [view, setView] = useState<View>({ kind: "idle" });
  const [pass, setPass] = useState<TicketPass | "loading" | "failed" | null>(
    null,
  );
  // The live session and mount, read by the executor at each async boundary.
  const current = useRef<ExecutorIdentity | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    current.current = executorIdentityOf(session);
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const where = { slug, launchId, objectId };
  const time = (value: string | null) =>
    value
      ? format.dateTime(new Date(value), {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : t("notStated");

  async function check() {
    setView({ kind: "busy", step: "checking" });
    try {
      setView({ kind: "state", state: await checkAdmission(where) });
    } catch (error) {
      setView({ kind: "failed", code: failureOf(error) });
    }
  }

  async function review(requestId: string) {
    setView({ kind: "busy", step: "reviewing" });
    try {
      const begun = await beginAdmission(where, requestId);
      setView({ kind: "confirm", ...begun });
    } catch (error) {
      setView({ kind: "failed", code: failureOf(error) });
    }
  }

  async function cancel(operationId: string) {
    // Before the reservation: zero writes. The request itself stays open.
    await cancelAdmission(where, operationId).catch(() => undefined);
    await check();
  }

  async function confirm(
    confirmation: AdmissionConfirmation,
    custom: Record<string, unknown>,
  ) {
    const { operationId } = confirmation;
    // The identity that may sign: the session as it is NOW, when the holder
    // confirms. Any change before or during signing stops the step.
    const expected = executorIdentityOf(session);
    if (!expected || expected.holder !== confirmation.holder) {
      setView({ kind: "failed", code: "session_expired" });
      return;
    }
    setView({ kind: "sending", step: "reserving", operationId });
    try {
      await confirmAdmission(where, operationId);
    } catch (error) {
      // Not won: possibly reserved, so only the original operation's status.
      setView(
        failureOf(error) === "unavailable" ||
          (error instanceof AdmissionError && error.code === "outcome_unknown")
          ? { kind: "state", state: { status: "unknown", operationId } }
          : { kind: "failed", code: failureOf(error) },
      );
      return;
    }
    let actionId: string;
    try {
      setView({ kind: "sending", step: "signing", operationId });
      actionId = await executeAdmission({
        objectId,
        custom,
        authenticationMethod: expected.authenticationMethod,
        controllerAddress: expected.controller ?? undefined,
        face: faceExecutionOf({
          face: { slug, launchId },
          operationId,
          expected,
          current: () => current.current,
          live: () => mounted.current,
        }),
      });
    } catch {
      // Won but not proven: never signed or sent again from here.
      setView({ kind: "state", state: { status: "unknown", operationId } });
      return;
    }
    setView({ kind: "sending", step: "verifying", operationId });
    try {
      const outcome = await recordAdmission(where, operationId, actionId);
      setView({ kind: "state", state: outcome });
    } catch {
      setView({ kind: "state", state: { status: "unknown", operationId } });
    }
  }

  async function status(operationId: string) {
    setView({ kind: "busy", step: "statusChecking" });
    try {
      setView({
        kind: "state",
        state: await admissionStatus(where, operationId),
      });
    } catch {
      setView({ kind: "state", state: { status: "unknown", operationId } });
    }
  }

  async function showPass() {
    setPass("loading");
    try {
      setPass(await readTicketPass(where));
    } catch {
      setPass("failed");
    }
  }

  const checkButton = (
    <Button variant="secondary" onClick={() => void check()}>
      {t("check")}
    </Button>
  );

  let body: React.ReactNode;
  switch (view.kind) {
    case "idle":
      body = (
        <>
          <p>{t("intro")}</p>
          {checkButton}
        </>
      );
      break;
    case "busy":
      body = <p role="status">{t(view.step)}</p>;
      break;
    case "sending":
      body = <p role="status">{t(view.step)}</p>;
      break;
    case "failed":
      body = (
        <>
          <Alert>{t(`failure.${view.code}`)}</Alert>
          {checkButton}
        </>
      );
      break;
    case "confirm":
      body = (
        <ConfirmEntry
          confirmation={view.confirmation}
          time={time}
          onCancel={() => void cancel(view.confirmation.operationId)}
          onConfirm={() => void confirm(view.confirmation, view.custom)}
        />
      );
      break;
    case "state": {
      const state = view.state;
      body =
        state.status === "none" ? (
          <>
            <p role="status">{t("none")}</p>
            {checkButton}
          </>
        ) : state.status === "expired" ? (
          <>
            <p role="status">{t("expired")}</p>
            {checkButton}
          </>
        ) : state.status === "awaiting_holder" ? (
          <>
            <p role="status">
              {t("awaiting", { expiresAt: time(state.request.expiresAt) })}
            </p>
            <Button onClick={() => void review(state.request.requestId)}>
              {t("review")}
            </Button>
          </>
        ) : state.status === "admitted" ? (
          <Alert tone="success">
            {t("admitted", {
              requestId: state.admission.requestId,
              receiptId: state.admission.receiptId,
            })}
          </Alert>
        ) : state.status === "unverified" ? (
          <>
            <Alert tone="info">{t("unverified")}</Alert>
            {checkButton}
          </>
        ) : (
          <>
            <Alert tone="info">{t("unknown")}</Alert>
            <Button
              variant="secondary"
              onClick={() => void status(state.operationId)}
            >
              {t("checkStatus")}
            </Button>
          </>
        );
      break;
    }
  }

  return (
    <section className="card ticket-detail" aria-labelledby="ticket-admission">
      <h2 id="ticket-admission">{t("title")}</h2>
      <div className="ticket-admission">{body}</div>
      <div className="ticket-admission-pass">
        {pass === null ? (
          <Button variant="secondary" onClick={() => void showPass()}>
            {t("pass")}
          </Button>
        ) : pass === "loading" ? (
          <p role="status">{t("checking")}</p>
        ) : pass === "failed" ? (
          <Alert>{t("failure.unavailable")}</Alert>
        ) : (
          <PassView pass={pass} />
        )}
      </div>
    </section>
  );
}

function ConfirmEntry({
  confirmation,
  time,
  onCancel,
  onConfirm,
}: {
  confirmation: AdmissionConfirmation;
  time: (value: string | null) => string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("tickets.admission");
  // The least consequential action takes focus first.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const facts: Array<[string, string]> = [
    [t("event"), confirmation.event.title],
    [t("venue"), confirmation.event.venue ?? t("notStated")],
    [
      t("window"),
      `${time(confirmation.window.startsAt)} – ${time(confirmation.window.endsAt)}`,
    ],
    [t("request"), confirmation.request.requestId],
    [t("expires"), time(confirmation.expiresAt)],
    [t("holder"), confirmation.holder],
    [t("effect"), t("effectValue", { from: confirmation.effect.from })],
  ];
  return (
    <ModalDialog
      labelledBy="ticket-admission-confirm-title"
      onClose={onCancel}
      initialFocusRef={cancelRef}
    >
      <header className="object-pass-modal-header">
        <h2 id="ticket-admission-confirm-title">{t("confirmTitle")}</h2>
      </header>
      <div className="object-pass-modal-body">
        <p>{t("confirmIntro")}</p>
        <dl className="ticket-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="product-face-confirm-actions">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button onClick={onConfirm}>{t("confirm")}</Button>
        </div>
      </div>
    </ModalDialog>
  );
}

function PassView({ pass }: { pass: TicketPass }) {
  const t = useTranslations("tickets.admission");
  const issuance = pass.issuance;
  return (
    <div className="ticket-pass">
      <h3>{t("passTitle")}</h3>
      <dl className="ticket-facts">
        <div>
          <dt>{t("passCode")}</dt>
          <dd className="ticket-pass-code">{pass.code}</dd>
        </div>
      </dl>
      <h3>{t("issuanceTitle")}</h3>
      {issuance ? (
        <>
          <dl className="ticket-facts">
            <div>
              <dt>{t("birthOperation")}</dt>
              <dd>{issuance.birthOperationId}</dd>
            </div>
            <div>
              <dt>{t("birthAction")}</dt>
              <dd>{issuance.birthActionId}</dd>
            </div>
          </dl>
          <p>
            {issuance.operationReadback === "current"
              ? t("operationCurrent")
              : t("operationSuperseded")}
          </p>
          <details>
            <summary>{t("contentHash")}</summary>
            <p className="ticket-pass-code">{issuance.activationHash}</p>
          </details>
        </>
      ) : (
        <p>{t("noIssuance")}</p>
      )}
    </div>
  );
}

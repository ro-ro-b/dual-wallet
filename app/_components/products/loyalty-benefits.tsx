"use client";

import { useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Alert } from "@/app/_components/design-system/alert";
import { Button } from "@/app/_components/design-system/button";
import type {
  LoyaltyBenefitsView,
  LoyaltyRedemptionStatus,
  LoyaltyRedemptionView,
} from "@/app/_domain/loyalty-benefits";
import {
  LoyaltyError,
  redemptionStatus,
  requestRedemption,
  showRedemptionReference,
  type BenefitsRead,
  type Where,
} from "@/app/_services/loyalty.client";

// loyalty-benefit-redeem-v1 on the native Loyalty page. Progress is the
// programme's own count; eligibility, the grant, the request, the partner's
// confirmation and the settlement are each shown only as the BFF proved them,
// and availability, terms and validity are labelled as the programme's
// records. The member only requests and shows their reference: the grant,
// the partner's confirmation and the settlement are other people's acts,
// named as the next step. Delivery is never claimed.

const FAILURES = [
  "redemption_in_progress",
  "loyalty_redemption_not_permitted",
  "loyalty_reward_changed",
  "loyalty_reward_expired",
  "loyalty_reward_unverified",
  "loyalty_redemption_already_requested",
  "loyalty_redemption_not_current",
  "membership_not_active",
  "session_expired",
];
const failureOf = (code: string) =>
  FAILURES.includes(code) ? code : "unavailable";

/**
 * The member's one-time reference, shown only on their own action, held in
 * this component's state only (never cached, stored or put in a URL), and
 * gone when hidden, when the page leaves, or when the request changes.
 */
function ReferencePanel({
  where,
  requestActionId,
  partnerName,
}: {
  where: Where;
  requestActionId: string;
  partnerName: string | null;
}) {
  const t = useTranslations("loyalty.benefits");
  const failure = useTranslations("loyalty.failure");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function show() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setCode(await showRedemptionReference(where, requestActionId));
    } catch (caught) {
      setError(
        failureOf(caught instanceof LoyaltyError ? caught.code : "unavailable"),
      );
    } finally {
      setBusy(false);
    }
  }
  if (code) {
    return (
      <section className="loyalty-reference" aria-label={t("referenceLabel")}>
        <p className="loyalty-reference-code" aria-live="polite">
          {code}
        </p>
        <p className="field-hint">
          {partnerName
            ? t("referenceNote", { partner: partnerName })
            : t("referenceNoteInHouse")}
        </p>
        <div className="loyalty-actions">
          <Button variant="secondary" onClick={() => setCode(null)}>
            {t("hideReference")}
          </Button>
        </div>
      </section>
    );
  }
  return (
    <>
      {error ? (
        <Alert>
          <span>{failure(error)}</span>
        </Alert>
      ) : null}
      <div className="loyalty-actions">
        <Button
          variant="secondary"
          onClick={() => void show()}
          aria-disabled={busy || undefined}
        >
          {t("showReference")}
        </Button>
      </div>
    </>
  );
}

type ItemStatus = LoyaltyRedemptionStatus | "unchecked" | "checking" | "failed";

function RequestItem({
  where,
  operationId,
  label,
  initial,
}: {
  where: Where;
  operationId: string;
  label: string;
  initial: ItemStatus;
}) {
  const t = useTranslations("loyalty.benefits");
  const [status, setStatus] = useState<ItemStatus>(initial);
  async function check() {
    setStatus("checking");
    try {
      setStatus((await redemptionStatus(where, operationId)).status);
    } catch {
      setStatus("failed");
    }
  }
  const final = status === "settled" || status === "not_received";
  return (
    <li className="card loyalty-submission">
      <strong>{label}</strong>
      <p role="status">{t(`request_status.${status}`)}</p>
      {final || status === "checking" ? null : (
        <div className="loyalty-actions">
          <Button variant="secondary" onClick={() => void check()}>
            {t("check")}
          </Button>
        </div>
      )}
    </li>
  );
}

function RewardPanel({
  view,
  where,
  onRequested,
}: {
  view: LoyaltyBenefitsView;
  where: Where;
  onRequested: (redemption: LoyaltyRedemptionView) => void;
}) {
  const t = useTranslations("loyalty.benefits");
  const failure = useTranslations("loyalty.failure");
  const format = useFormatter();
  const [error, setError] = useState<string | null>(null);
  const [sendingState, setSendingState] = useState(false);
  // Sent (or possibly sent): never offered again from this page.
  const [sent, setSent] = useState(false);
  // Synchronous, held until the answer's render commits: one request only.
  const sending = useRef(false);
  useEffect(() => {
    if (!sendingState) sending.current = false;
  }, [sendingState]);
  const reward = view.reward!;
  const benefit = view.benefits.find(
    (item) => item.benefitId === reward.benefitId,
  );
  async function request() {
    if (sending.current || !reward.grantActionId) return;
    sending.current = true;
    setSendingState(true);
    setError(null);
    const outcome = await requestRedemption(
      where,
      reward.benefitId,
      reward.grantActionId,
    );
    if (outcome.kind === "sent") {
      setSent(true);
      onRequested(outcome.redemption);
    } else setError(failureOf(outcome.code));
    setSendingState(false);
  }
  return (
    <section className="card loyalty-section" aria-labelledby="loyalty-reward">
      <h3 id="loyalty-reward">{t("rewardTitle")}</h3>
      <p>
        <strong>{benefit?.title ?? reward.benefitId}</strong>
      </p>
      <p role="status">{t(`status.${reward.status}`)}</p>
      {reward.status === "granted" || reward.status === "requested" ? (
        <p className="field-hint">
          {t("validUntil", {
            date: format.dateTime(new Date(reward.validUntil), {
              dateStyle: "medium",
            }),
          })}
        </p>
      ) : null}
      {view.held ? <p className="field-hint">{t("heldNote")}</p> : null}
      {error ? (
        <Alert>
          <span>{failure(error)}</span>
        </Alert>
      ) : null}
      {view.actions.requestRedemption && !sent ? (
        <>
          <div className="loyalty-actions">
            <Button
              onClick={() => void request()}
              aria-disabled={sendingState || undefined}
            >
              {sendingState ? t("requesting") : t("request")}
            </Button>
          </div>
          <p className="field-hint">{t("requestNote")}</p>
        </>
      ) : null}
      {view.actions.showReference && reward.requestActionId ? (
        <ReferencePanel
          key={reward.requestActionId}
          where={where}
          requestActionId={reward.requestActionId}
          partnerName={benefit?.partnerName ?? null}
        />
      ) : null}
      {reward.status === "confirmed" || reward.status === "settled" ? (
        <p className="field-hint">{t("fulfilment")}</p>
      ) : null}
      {reward.status === "settled" ? (
        <p className="field-hint">{t("settlementNote")}</p>
      ) : null}
    </section>
  );
}

/** The proven benefits of one created membership, with its next step. */
export function BenefitsSection({
  where,
  read,
  onChanged,
}: {
  where: Where;
  read: {
    data?: BenefitsRead;
    isPending: boolean;
    isError: boolean;
    refetch: () => unknown;
  };
  onChanged: () => void;
}) {
  const t = useTranslations("loyalty.benefits");
  // This page's own new requests, with the status their send proved.
  const [recent, setRecent] = useState<LoyaltyRedemptionView[]>([]);
  if (read.isPending) return <p role="status">{t("title")}…</p>;
  if (read.isError || !read.data) {
    return (
      <Alert>
        <span>{t("unavailable")}</span>
        <Button variant="secondary" onClick={() => void read.refetch()}>
          {t("retry")}
        </Button>
      </Alert>
    );
  }
  if (read.data.unconfirmed) {
    return (
      <Alert>
        <span>{t("unconfirmedAll")}</span>
        <Button variant="secondary" onClick={() => void read.refetch()}>
          {t("retry")}
        </Button>
      </Alert>
    );
  }
  const view = read.data.benefits;
  if (!view) return null;
  const titleOf = (benefitId: string) =>
    view.benefits.find((item) => item.benefitId === benefitId)?.title ??
    benefitId;
  const known = new Set(recent.map((item) => item.operationId));
  const listed = read.data.redemptions.filter(
    (item) => !known.has(item.operationId),
  );
  return (
    <section aria-labelledby="loyalty-benefits">
      <h3 id="loyalty-benefits">{t("title")}</h3>
      {view.next ? <p role="status">{t(`next.${view.next}`)}</p> : null}
      <section aria-labelledby="loyalty-progress">
        <h4 id="loyalty-progress">{t("progressTitle")}</h4>
        <p className="field-hint">{t("progressNote")}</p>
        <ul className="loyalty-progress">
          {view.progress.map((rule) => (
            <li key={rule.ruleId}>
              {t("progress", {
                label: rule.label,
                verified: Math.min(rule.verified, rule.requiredVerified),
                required: rule.requiredVerified,
              })}
              {rule.pendingVerification ? ` ${t("progressPending")}` : ""}
            </li>
          ))}
        </ul>
      </section>
      {view.reward ? (
        <RewardPanel
          view={view}
          where={where}
          onRequested={(redemption) => {
            setRecent((items) => [redemption, ...items]);
            onChanged();
          }}
        />
      ) : null}
      <ul className="loyalty-benefit-list">
        {view.benefits.map((benefit) => (
          <li key={benefit.benefitId} className="card loyalty-benefit">
            <strong>{benefit.title}</strong>
            {benefit.description ? <p>{benefit.description}</p> : null}
            <p role="status">{t(`status.${benefit.status}`)}</p>
            <p className="field-hint">
              {t(`availability.${benefit.availability}`)}
            </p>
            <p className="field-hint">
              {benefit.partnerName
                ? t("partner", { partner: benefit.partnerName })
                : t("inHouse")}{" "}
              {t("validity", { days: benefit.validDays })}
            </p>
            {benefit.terms ? (
              <p className="field-hint">{benefit.terms}</p>
            ) : null}
          </li>
        ))}
      </ul>
      {recent.length || listed.length ? (
        <section aria-labelledby="loyalty-requests">
          <h4 id="loyalty-requests">{t("requestsTitle")}</h4>
          <ul className="loyalty-submissions">
            {recent.map((item) => (
              <RequestItem
                key={item.operationId}
                where={where}
                operationId={item.operationId}
                label={titleOf(item.benefitId)}
                initial={item.status}
              />
            ))}
            {listed.map((item) => (
              <RequestItem
                key={item.operationId}
                where={where}
                operationId={item.operationId}
                label={titleOf(item.benefitId)}
                initial="unchecked"
              />
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

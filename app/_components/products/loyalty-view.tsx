"use client";

import { useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Alert } from "@/app/_components/design-system/alert";
import { Button } from "@/app/_components/design-system/button";
import {
  SelectField,
  TextareaField,
} from "@/app/_components/design-system/field";
import { PageHeader } from "@/app/_components/design-system/page-header";
import { newFaceLaunchId } from "@/app/_domain/product-face";
import { BenefitsSection } from "@/app/_components/products/loyalty-benefits";
import {
  EVIDENCE_MAX,
  SUBMITTABLE_STATES,
  type LoyaltyMembershipView,
  type LoyaltyProgramme,
  type LoyaltySubmissionStatus,
} from "@/app/_domain/loyalty";
import {
  useLoyaltyBenefits,
  useLoyaltyMembership,
  useLoyaltyProgramme,
  useRefreshMembership,
} from "@/app/_hooks/use-loyalty";
import { useSession } from "@/app/_providers/session-provider";
import {
  joinProgramme,
  LoyaltyError,
  submissionStatus,
  submitActivity,
  type Where,
} from "@/app/_services/loyalty.client";

// loyalty-join-earn-v1 on the wallet's native Loyalty page. Every state shown
// was proven by the BFF from fresh reads; a join and a submission happen only
// on the member's own action, and a submission that may have been sent (its
// answer lost, even whole) is only ever checked again under its original
// operation, never sent twice. No points, tiers or
// rejections are shown: the programme verifies, and until it does an
// activity is waiting.

const FAILURES = [
  "consent_required",
  "consent_changed",
  "join_already_requested",
  "membership_exists",
  "programme_closed",
  "programme_not_found",
  "loyalty_activity_evidence_duplicate",
  "loyalty_activity_type_unknown",
  "membership_not_active",
  "submission_in_progress",
  "loyalty_activity_not_permitted",
  "capability_not_granted",
  "session_expired",
];

const failureOf = (error: unknown) =>
  error instanceof LoyaltyError && FAILURES.includes(error.code)
    ? error.code
    : "unavailable";

function Failure({
  code,
  slug,
  retry,
}: {
  code: string;
  slug: string;
  retry?: () => void;
}) {
  const t = useTranslations("loyalty.failure");
  if (code === "session_expired") {
    return (
      <Alert>
        <span>
          {t("session_expired")}{" "}
          {/* A protected route: sign-in returns to exactly this page. */}
          <a href={`/products/${slug}/loyalty`}>{t("signIn")}</a>
        </span>
      </Alert>
    );
  }
  return (
    <Alert>
      <span>{t(code)}</span>
      {retry && code === "unavailable" ? (
        <Button variant="secondary" onClick={retry}>
          {t("retry")}
        </Button>
      ) : null}
    </Alert>
  );
}

type JoinStep =
  { kind: "editing"; agreed: boolean; error?: string } | { kind: "sending" };

function JoinForm({
  programme,
  where,
  onJoined,
}: {
  programme: LoyaltyProgramme;
  where: Where;
  onJoined: () => void;
}) {
  const t = useTranslations("loyalty");
  const [step, setStep] = useState<JoinStep>({
    kind: "editing",
    agreed: false,
  });
  if (!programme.open) return <p role="status">{t("closed")}</p>;
  const agreed = step.kind === "editing" && step.agreed;
  async function join() {
    if (step.kind !== "editing") return;
    if (!step.agreed) {
      setStep({ ...step, error: "consent_required" });
      return;
    }
    setStep({ kind: "sending" });
    try {
      await joinProgramme(where, {
        termsVersion: programme.termsVersion,
        fingerprint: programme.consentFingerprint,
      });
      onJoined();
    } catch (error) {
      setStep({ kind: "editing", agreed: true, error: failureOf(error) });
    }
  }
  return (
    <form
      className="loyalty-form"
      onSubmit={(event) => {
        event.preventDefault();
        void join();
      }}
    >
      <h3>{t("termsTitle", { version: programme.termsVersion })}</h3>
      <p>{programme.consentStatement}</p>
      {programme.dataUse ? <p>{programme.dataUse}</p> : null}
      <label className="loyalty-consent">
        <input
          type="checkbox"
          name="consent"
          checked={agreed}
          disabled={step.kind === "sending"}
          onChange={(event) =>
            setStep({ kind: "editing", agreed: event.target.checked })
          }
        />
        <span>{t("agree", { version: programme.termsVersion })}</span>
      </label>
      {step.kind === "editing" && step.error ? (
        <Failure code={step.error} slug={where.slug} />
      ) : null}
      <div className="loyalty-actions">
        <Button
          type="submit"
          aria-disabled={step.kind === "sending" || undefined}
        >
          {step.kind === "sending" ? t("joining") : t("join")}
        </Button>
      </div>
      <p className="field-hint">{t("joinNote")}</p>
    </form>
  );
}

type SubmitStep = { kind: "editing"; error?: string } | { kind: "sending" };

function ActivityForm({
  programme,
  where,
  onSubmitted,
}: {
  programme: LoyaltyProgramme;
  where: Where;
  onSubmitted: (submission: {
    operationId: string;
    activityType: string;
    status: LoyaltySubmissionStatus;
  }) => void;
}) {
  const t = useTranslations("loyalty");
  const [activityType, setActivityType] = useState(
    programme.activities[0]?.activityType ?? "",
  );
  const [evidence, setEvidence] = useState("");
  const [step, setStep] = useState<SubmitStep>({ kind: "editing" });
  // Synchronous, and held until the answer's render commits: a second click
  // (a double click, a stale handler) starts nothing.
  const sending = useRef(false);
  useEffect(() => {
    if (step.kind === "editing") sending.current = false;
  }, [step]);
  const activity = programme.activities.find(
    (item) => item.activityType === activityType,
  );
  if (!programme.activities.length) {
    return <p role="status">{t("noActivities")}</p>;
  }
  async function submit() {
    if (sending.current) return;
    const evidenceRef = evidence.trim();
    if (!evidenceRef || evidenceRef.length > EVIDENCE_MAX) {
      setStep({ kind: "editing", error: "evidence_required" });
      return;
    }
    sending.current = true;
    setStep({ kind: "sending" });
    const outcome = await submitActivity(where, activityType, evidenceRef);
    if (outcome.kind !== "sent") {
      setStep({
        kind: "editing",
        error: FAILURES.includes(outcome.code) ? outcome.code : "unavailable",
      });
      return;
    }
    // Sent or possibly sent: listed under its own operation from now on.
    setEvidence("");
    setStep({ kind: "editing" });
    onSubmitted(outcome.submission);
  }
  return (
    <form
      className="loyalty-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <SelectField
        label={t("activityType")}
        value={activityType}
        onChange={(event) => setActivityType(event.target.value)}
        disabled={step.kind === "sending"}
      >
        {programme.activities.map((item) => (
          <option key={item.activityType} value={item.activityType}>
            {item.label}
          </option>
        ))}
      </SelectField>
      <TextareaField
        label={t("evidence")}
        hint={activity?.evidenceHint || t("evidenceHint")}
        value={evidence}
        maxLength={EVIDENCE_MAX}
        rows={3}
        disabled={step.kind === "sending"}
        onChange={(event) => setEvidence(event.target.value)}
        error={
          step.kind === "editing" && step.error === "evidence_required"
            ? t("evidenceRequired")
            : undefined
        }
      />
      {step.kind === "editing" &&
      step.error &&
      step.error !== "evidence_required" ? (
        <Failure code={step.error} slug={where.slug} />
      ) : null}
      <div className="loyalty-actions">
        <Button
          type="submit"
          aria-disabled={step.kind === "sending" || undefined}
        >
          {step.kind === "sending" ? t("submitting") : t("submit")}
        </Button>
      </div>
      <p className="field-hint">{t("submitNote")}</p>
    </form>
  );
}

type ItemStatus = LoyaltySubmissionStatus | "unchecked" | "checking" | "failed";

function SubmissionItem({
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
  const t = useTranslations("loyalty.submission");
  const [status, setStatus] = useState<ItemStatus>(initial);
  async function check() {
    setStatus("checking");
    try {
      setStatus((await submissionStatus(where, operationId)).status);
    } catch {
      setStatus("failed");
    }
  }
  const checkable =
    status === "unchecked" ||
    status === "unknown" ||
    status === "unconfirmed" ||
    status === "submitted" ||
    status === "failed";
  return (
    <li className="card loyalty-submission">
      <strong>{label}</strong>
      <p role="status">{t(status)}</p>
      {checkable ? (
        <div className="loyalty-actions">
          <Button variant="secondary" onClick={() => void check()}>
            {t("check")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Why an activity is not offered now: the lifecycle's next step. */
const WAIT: Record<string, string> = {
  "Activity pending": "activity_pending",
  "Benefit eligible": "benefit_eligible",
  "Redemption pending": "redemption_pending",
  Redeemed: "redeemed",
  Fulfilled: "fulfilled",
  "Fulfilment failed": "fulfilment_failed",
};

function MembershipSection({
  view,
  programme,
  where,
  walletId,
  benefitsEnabled,
  submissions,
  onChanged,
}: {
  view: LoyaltyMembershipView;
  programme: LoyaltyProgramme;
  where: Where;
  walletId: string;
  benefitsEnabled: boolean;
  submissions: Array<{ operationId: string; activityType: string }>;
  onChanged: () => void;
}) {
  const t = useTranslations("loyalty");
  const format = useFormatter();
  const created =
    view.status === "active" ||
    view.status === "held" ||
    view.status === "ended";
  const benefits = useLoyaltyBenefits({
    slug: where.slug,
    launchId: where.launchId,
    walletId,
    enabled: benefitsEnabled && created,
  });
  const benefitsSection =
    benefitsEnabled && created ? (
      <BenefitsSection where={where} read={benefits} onChanged={onChanged} />
    ) : null;
  // This page's own new submissions, with the status their send proved.
  const [recent, setRecent] = useState<
    Array<{
      operationId: string;
      activityType: string;
      status: LoyaltySubmissionStatus;
    }>
  >([]);
  const labelOf = (activityType: string) =>
    programme.activities.find((item) => item.activityType === activityType)
      ?.label ?? activityType;
  const date = (value: string) =>
    format.dateTime(new Date(value), { dateStyle: "medium" });
  switch (view.status) {
    case "none":
      return (
        <JoinForm programme={programme} where={where} onJoined={onChanged} />
      );
    case "pending_approval":
    case "declined":
    case "pending_creation":
      return (
        <>
          <p role="status">{t(`status.${view.status}`)}</p>
          {/* The programme's own record of the consent: not a Dual fact. */}
          <p className="field-hint">
            {t("consentRecord", {
              version: view.join.termsVersion,
              date: date(view.join.requestedAt),
            })}
          </p>
        </>
      );
    case "pending_pass":
    case "held":
    case "ended":
    case "unconfirmed":
      return (
        <>
          <p role="status">{t(`status.${view.status}`)}</p>
          {view.status === "unconfirmed" ? (
            <div className="loyalty-actions">
              <Button variant="secondary" onClick={onChanged}>
                {t("failure.retry")}
              </Button>
            </div>
          ) : null}
          {/* Held or ended: the reward's last proven step, as the past. */}
          {benefitsSection}
        </>
      );
    case "active": {
      const known = new Set(recent.map((item) => item.operationId));
      const state = view.membership.state;
      // Only from a state where it strands nothing (benefit-redeem §6); with
      // benefits, exactly as the proven view permits.
      const offered = benefitsEnabled
        ? Boolean(benefits.data?.benefits?.actions.submitActivity)
        : SUBMITTABLE_STATES.includes(state);
      return (
        <>
          <p role="status">{t("status.active")}</p>
          <section aria-labelledby="loyalty-activity">
            <h3 id="loyalty-activity">{t("activityTitle")}</h3>
            {offered ? (
              <ActivityForm
                programme={programme}
                where={where}
                onSubmitted={(submission) => {
                  setRecent((items) => [submission, ...items]);
                  onChanged();
                }}
              />
            ) : benefitsEnabled && benefits.isPending ? null : (
              <p role="status">{t(`activityWait.${WAIT[state] ?? "other"}`)}</p>
            )}
          </section>
          <section aria-labelledby="loyalty-submissions">
            <h3 id="loyalty-submissions">{t("submissionsTitle")}</h3>
            {recent.length || submissions.length ? (
              <ul className="loyalty-submissions">
                {recent.map((item) => (
                  <SubmissionItem
                    key={item.operationId}
                    where={where}
                    operationId={item.operationId}
                    label={labelOf(item.activityType)}
                    initial={item.status}
                  />
                ))}
                {submissions
                  .filter((item) => !known.has(item.operationId))
                  .map((item) => (
                    <SubmissionItem
                      key={item.operationId}
                      where={where}
                      operationId={item.operationId}
                      label={labelOf(item.activityType)}
                      initial="unchecked"
                    />
                  ))}
              </ul>
            ) : (
              <p>{t("noSubmissions")}</p>
            )}
          </section>
          {benefitsSection}
        </>
      );
    }
  }
}

/** The member's native Loyalty page for one programme. */
export function LoyaltyView({
  slug,
  programmeName,
}: {
  slug: string;
  programmeName: string;
}) {
  const t = useTranslations("loyalty");
  const { wallet } = useSession();
  const [launchId] = useState(newFaceLaunchId);
  const where = { slug, launchId };
  const input = { slug, launchId, walletId: wallet?.id };
  const programme = useLoyaltyProgramme(input);
  const membership = useLoyaltyMembership(input);
  const refresh = useRefreshMembership({ slug, walletId: wallet?.id });
  const header = (
    <PageHeader
      eyebrow={programmeName}
      title={programme.data?.name ?? t("title")}
      description={programme.data?.headline || t("description")}
    />
  );
  const error = programme.error ?? membership.error;
  if (error) {
    return (
      <div className="loyalty-view">
        {header}
        <Failure
          code={failureOf(error)}
          slug={slug}
          retry={() => {
            void programme.refetch();
            void membership.refetch();
          }}
        />
      </div>
    );
  }
  const programmeData = programme.data;
  const membershipData = membership.data;
  if (!programmeData || !membershipData) {
    return (
      <div className="loyalty-view">
        {header}
        <p role="status">{t("loading")}</p>
      </div>
    );
  }
  return (
    <div className="loyalty-view">
      {header}
      {programmeData.memberPromise ? (
        <p className="loyalty-promise">{programmeData.memberPromise}</p>
      ) : null}
      <section
        className="card loyalty-section"
        aria-labelledby="loyalty-membership"
      >
        <h2 id="loyalty-membership">{t("membershipTitle")}</h2>
        <MembershipSection
          // Another wallet or programme starts from nothing on this page.
          key={`${slug}:${wallet?.id ?? ""}`}
          view={membershipData.membership}
          programme={programmeData}
          where={where}
          walletId={wallet?.id ?? ""}
          benefitsEnabled={membershipData.benefits}
          submissions={membershipData.submissions}
          onChanged={() => void refresh()}
        />
      </section>
    </div>
  );
}

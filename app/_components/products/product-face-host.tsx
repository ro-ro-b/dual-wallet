"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, LoaderCircle, ShieldCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Alert } from "@/app/_components/design-system/alert";
import { Button } from "@/app/_components/design-system/button";
import { ProductFaceConfirmationDialog } from "@/app/_components/products/product-face-confirmation";
import {
  newFaceLaunchId,
  ProductFaceError,
  taskPathFromPathname,
  type ProductFaceApplication,
  type SessionEndReason,
} from "@/app/_domain/product-face";
import { productFaceContextQueryOptions } from "@/app/_hooks/query-options";
import { useProductFaceHost } from "@/app/_hooks/use-product-face-host";
import type { ProductFaceHostNotice } from "@/app/_lib/external-face-bridge/core/product-session";
import { useHostPresentation } from "@/app/_providers/host-provider";
import { useSession } from "@/app/_providers/session-provider";

// No popups, downloads, top navigation or device permissions. The frame is
// a cross-origin first-party reviewed application on its own origin.
const PRODUCT_FACE_SANDBOX = "allow-scripts allow-same-origin allow-forms";

const knownErrors = [
  "artifact_mismatch",
  "artifact_unavailable",
  "unknown_application",
  "session_expired",
] as const;

type RecoveryItem = Extract<
  ProductFaceHostNotice,
  { kind: "recovery" }
>["items"][number];

/**
 * Proposed contract r20 (not deployed): the copy for one recovered outcome.
 * A kind-specific line exists only where the kind changes the meaning (a
 * registration, the brand's confirmation of one, a transfer step, a service
 * request); every other outcome reads the same whatever was sent.
 */
/** The BFF's reasons the host has words for; anything else is not shown. */
const recoveryReasons = [
  "runtime_incomplete",
  "echo_mismatch",
  "time_invalid",
  "snapshot_changed",
  "cursor_cycle",
  "out_of_order",
  "pages_exceeded",
  "read_failed",
  "item_unreadable",
  "unreachable",
  "invalid",
  "unsigned",
] as const;
function recoveryReasonOf(reason: string | null) {
  return recoveryReasons.find((known) => known === reason);
}

/**
 * A recovered transfer line speaks of who holds the product now ("still
 * yours until the handover is done", "the handover has not been done yet",
 * "now belongs to the recipient"). Where the unit's current holding (the
 * BFF's fresh read) contradicts those words, or cannot tell them from a
 * handover completed since (an offer on a product registered to you), the
 * line says only what holds now; otherwise, and whenever the holding is
 * unread, the outcome's own line stands.
 */
const currentTransferLines = {
  transfer_offered: ["registered", "elsewhere"],
  transfer_cancelled: ["elsewhere"],
  transfer_request_committed: ["registered", "elsewhere"],
  transferred: ["registered", "held"],
} as const satisfies Record<
  string,
  readonly NonNullable<RecoveryItem["holding"]>[]
>;

function currentLineKey(
  line: keyof typeof currentTransferLines,
  holding: RecoveryItem["holding"],
) {
  const contradicted: readonly string[] = currentTransferLines[line];
  return holding && contradicted.includes(holding)
    ? (`notices.recovery.current.${line}.${holding}` as const)
    : undefined;
}

function recoveryLineKey(item: RecoveryItem) {
  switch (item.outcome) {
    case "registered":
      return item.kind === "settle"
        ? "notices.recovery.settle.registered"
        : "notices.recovery.registration.registered";
    case "transfer_request_committed":
    case "transferred":
      return (
        currentLineKey(item.outcome, item.holding) ??
        (`notices.recovery.transfer.${item.outcome}` as const)
      );
    case "write_applied":
      // A runtime write is a service request (case.*) or a transfer offer
      // or its cancellation: each is told as what it was.
      if (item.operation === "transfer.offer") {
        return (
          currentLineKey("transfer_offered", item.holding) ??
          "notices.recovery.runtime.transfer_offered"
        );
      }
      if (item.operation === "transfer.cancel") {
        return (
          currentLineKey("transfer_cancelled", item.holding) ??
          "notices.recovery.runtime.transfer_cancelled"
        );
      }
      return "notices.recovery.runtime.write_applied";
    default:
      return `notices.recovery.any.${item.outcome}` as const;
  }
}

/**
 * One slim row: Back, the programme name and a disclosure for the publisher.
 * On wide screens the publisher line is always shown and the disclosure
 * button is hidden (CSS); on phones it opens below the row, so the frame gets
 * the remaining height.
 */
function IdentityBar({
  application,
}: {
  application?: ProductFaceApplication;
}) {
  const t = useTranslations("products");
  const host = useHostPresentation();
  // A branded host without the My products journey has no programme list.
  const back = host && !host.journeys.myProducts ? "/" : "/products";
  const [aboutOpen, setAboutOpen] = useState(false);
  const aboutId = useId();
  return (
    <header className="product-face-identity" aria-label={t("identityLabel")}>
      <Link href={back} className="product-face-back">
        <ArrowLeft size={18} aria-hidden />
        <span className="product-face-back-label">{t("back")}</span>
        <span className="product-face-back-short" aria-hidden>
          {t("backShort")}
        </span>
      </Link>
      {application ? (
        <>
          <h1 className="product-face-title" title={application.programme.name}>
            {application.programme.name}
          </h1>
          <button
            type="button"
            className="product-face-about"
            aria-expanded={aboutOpen}
            aria-controls={aboutId}
            onClick={() => setAboutOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setAboutOpen(false);
            }}
          >
            <ShieldCheck size={18} aria-hidden />
            <span className="sr-only">
              {t("about", { programme: application.programme.name })}
            </span>
          </button>
          <p
            id={aboutId}
            className="product-face-publisher"
            data-open={aboutOpen ? "true" : "false"}
          >
            <ShieldCheck size={14} aria-hidden />
            <span>{t("publisher", { publisher: application.publisher })}</span>
          </p>
        </>
      ) : null}
    </header>
  );
}

function ProductFaceFrame({
  slug,
  launchId,
  application,
  frameUrl,
  onEnded,
  onRelaunch,
}: {
  slug: string;
  launchId: string;
  application: ProductFaceApplication;
  frameUrl: string;
  onEnded: (reason: SessionEndReason) => void;
  /** A new launch of this face: a fresh frame and its own journal. */
  onRelaunch: () => void;
}) {
  const t = useTranslations("products");
  const { wallet } = useSession();
  const {
    state,
    confirmation,
    answerConfirmation,
    onFrameLoad,
    notice,
    dismissNotice,
    continueRecovery,
    checkRecoveryAgain,
  } = useProductFaceHost({ slug, launchId, application, frameUrl, onEnded });

  if (state.status === "ended") return null;

  return (
    <>
      {notice ? (
        <div className="product-face-notice" role="status">
          <Alert tone="info">
            {notice.kind === "recovery" ? (
              // The host's own words for what the runtime proved about the
              // person's earlier requests; nothing here was re-sent.
              <div>
                {notice.items.map((item) => (
                  <p key={item.operationId}>
                    {t(recoveryLineKey(item), {
                      publisher: application.publisher,
                    })}
                  </p>
                ))}
                {notice.checks.map((check) => (
                  <p key={check.runtime}>
                    {t(
                      `notices.recoveryCheck.${check.runtime}.${check.status}`,
                      {
                        publisher: application.publisher,
                      },
                    )}
                    {recoveryReasonOf(check.reason) ? (
                      <>
                        {" "}
                        {t(
                          `notices.recoveryReason.${recoveryReasonOf(check.reason)!}`,
                        )}
                      </>
                    ) : null}
                  </p>
                ))}
                {notice.unreadable > 0 ? (
                  <p>
                    {t("notices.recoveryUnreadable", {
                      count: notice.unreadable,
                    })}
                  </p>
                ) : null}
                {notice.complete ? null : (
                  <p>{t("notices.recoveryIncomplete")}</p>
                )}
                {notice.moreToCheck ? <p>{t("notices.recoveryMore")}</p> : null}
                {notice.withheld > 0 ? (
                  <p>{t("notices.recoveryWithheld")}</p>
                ) : null}
              </div>
            ) : (
              t(`notices.${notice.kind}.${notice.reason}`, {
                publisher: application.publisher,
              })
            )}
          </Alert>
          {notice.kind === "launch_full" && notice.reason === "journal_full" ? (
            <Button onClick={onRelaunch}>{t("notices.relaunch")}</Button>
          ) : null}
          {notice.kind === "recovery" && notice.moreToCheck ? (
            <Button onClick={continueRecovery}>
              {t("notices.recoveryContinue")}
            </Button>
          ) : null}
          {notice.kind === "recovery" &&
          !notice.complete &&
          !notice.moreToCheck ? (
            <Button onClick={checkRecoveryAgain}>
              {t("notices.recoveryCheckAgain")}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={dismissNotice}>
            {t("notices.dismiss")}
          </Button>
        </div>
      ) : null}
      {state.status === "loading" ? (
        <p className="product-face-status" role="status">
          <LoaderCircle size={18} className="animate-spin" aria-hidden />
          {t("loading")}
        </p>
      ) : null}
      <iframe
        className="product-face-frame"
        src={frameUrl}
        title={t("frameTitle", { programme: application.programme.name })}
        sandbox={PRODUCT_FACE_SANDBOX}
        allow=""
        referrerPolicy="no-referrer"
        onLoad={(event) => onFrameLoad(event.currentTarget)}
      />
      {confirmation && wallet ? (
        <ProductFaceConfirmationDialog
          request={confirmation}
          application={application}
          walletAddress={wallet.account.address}
          onAnswer={answerConfirmation}
        />
      ) : null}
    </>
  );
}

// Every frame is its own launch: a fresh launch id keys its own journal and
// selection on the server, so two tabs never overwrite each other.
type HostPhase =
  | { status: "open"; instance: number; launchId: string }
  | {
      status: "ended";
      instance: number;
      launchId: string;
      reason: SessionEndReason;
    };

/** Full-size host for one programme's reviewed product application. */
export function ProductFaceHost({ slug }: { slug: string }) {
  const t = useTranslations("products");
  const { wallet, isAuthenticated } = useSession();
  const [phase, setPhase] = useState<HostPhase>(() => ({
    status: "open",
    instance: 0,
    launchId: newFaceLaunchId(),
  }));
  const pathname = usePathname();
  const context = useQuery(
    productFaceContextQueryOptions(
      slug,
      phase.launchId,
      Boolean(wallet) && phase.status === "open",
      taskPathFromPathname(pathname, slug) ?? "/",
    ),
  );
  const errorCode =
    context.error instanceof ProductFaceError ? context.error.code : undefined;

  return (
    <section className="product-face-shell">
      <IdentityBar application={context.data?.application} />
      <div className="product-face-stage">
        {phase.status === "ended" ? (
          <div className="product-face-ended">
            <Alert tone="info">{t(`ended.${phase.reason}`)}</Alert>
            {isAuthenticated && phase.reason === "account_changed" ? (
              <Button
                variant="secondary"
                onClick={() =>
                  setPhase({
                    status: "open",
                    instance: phase.instance + 1,
                    launchId: newFaceLaunchId(),
                  })
                }
              >
                {t("ended.reopen")}
              </Button>
            ) : null}
          </div>
        ) : context.data ? (
          <ProductFaceFrame
            key={phase.instance}
            slug={slug}
            launchId={phase.launchId}
            application={context.data.application}
            frameUrl={context.data.frameUrl}
            onRelaunch={() =>
              setPhase((current) => ({
                status: "open",
                instance: current.instance + 1,
                launchId: newFaceLaunchId(),
              }))
            }
            onEnded={(reason) =>
              setPhase((current) => ({
                status: "ended",
                instance: current.instance,
                launchId: current.launchId,
                reason,
              }))
            }
          />
        ) : context.isError ? (
          <Alert>
            {knownErrors.includes(errorCode as (typeof knownErrors)[number])
              ? t(`errors.${errorCode as (typeof knownErrors)[number]}`)
              : t("errors.generic")}
          </Alert>
        ) : (
          <p className="product-face-status" role="status">
            <LoaderCircle size={18} className="animate-spin" aria-hidden />
            {t("loading")}
          </p>
        )}
      </div>
    </section>
  );
}

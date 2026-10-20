"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Ticket as TicketIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert } from "@/app/_components/design-system/alert";
import { Button, buttonClass } from "@/app/_components/design-system/button";
import { EmptyState } from "@/app/_components/design-system/empty-state";
import { PageHeader } from "@/app/_components/design-system/page-header";
import { useFocusOnMount } from "@/app/_hooks/use-focus-on-mount";
import { newFaceLaunchId } from "@/app/_domain/product-face";
import {
  admissionMayHaveWritten,
  type AdmissionState,
} from "@/app/_domain/ticket-admission";
import type { Ticket, TicketStatus } from "@/app/_domain/tickets";
import {
  useRefreshTicket,
  useTicket,
  useTickets,
} from "@/app/_hooks/use-tickets";
import { useSession } from "@/app/_providers/session-provider";
import { TicketAdmission } from "@/app/_components/products/ticket-admission";
import { useTicketTime } from "@/app/_components/products/ticket-time";
import { TicketsError } from "@/app/_services/tickets.client";

/**
 * A ticket's own status, or (on its detail page only) an entry the gate
 * verified and a later Dual read agrees with.
 */
type TicketBadge = TicketStatus | "entry_confirmed";

const statusTone: Record<TicketBadge, string> = {
  issued: "status-completed",
  pending: "status-pending",
  ended: "status-neutral",
  unconfirmed: "status-neutral",
  admission_recorded: "status-neutral",
  entry_confirmed: "status-completed",
};

/**
 * The badge names Studio's exact end state (Cancelled, Expired) when the
 * projection verified it; any other ended state stays "No longer valid".
 */
export function TicketStatusBadge({
  status,
  endedAs = null,
}: {
  status: TicketBadge;
  endedAs?: Ticket["endedAs"];
}) {
  const t = useTranslations("tickets.status");
  return (
    <span className={`status ${statusTone[status]}`}>
      {t(status === "ended" && endedAs ? endedAs : status)}
    </span>
  );
}

/**
 * A still-issued ticket whose verified entry window has passed. Its canonical
 * state is unchanged (still issued, never "expired"); only entry is over.
 */
export const entryWindowClosed = (ticket: Ticket) =>
  ticket.status === "issued" && ticket.entryWindow?.closed === true;

/** What a failed read means for the holder, and what they can do next. */
function TicketsFailure({
  error,
  retry,
  returnPath,
  takeFocus = false,
}: {
  error: unknown;
  retry: () => void;
  returnPath: string;
  /** For a failure that replaces the control the holder just used. */
  takeFocus?: boolean;
}) {
  const t = useTranslations("tickets.failure");
  const failure = error instanceof TicketsError ? error.failure : "unavailable";
  if (failure === "session_expired") {
    return (
      <Alert takeFocus={takeFocus}>
        <span>
          {t("session_expired")}{" "}
          {/* A protected route: sign-in returns to exactly this page. */}
          <a href={returnPath}>{t("signIn")}</a>
        </span>
      </Alert>
    );
  }
  if (failure === "not_found" || failure === "capability_not_granted") {
    return <Alert tone="info">{t(failure)}</Alert>;
  }
  return (
    <Alert>
      <span>{t("unavailable")}</span>
      <Button variant="secondary" onClick={retry}>
        {t("retry")}
      </Button>
    </Alert>
  );
}

function TicketCard({ slug, ticket }: { slug: string; ticket: Ticket }) {
  const t = useTranslations("tickets");
  const time = useTicketTime();
  // The event's start, else when entry opens, said as that (never as the
  // event's start), as on the home.
  const eventStart = time(ticket.event.startsAt);
  const opening = time(ticket.entryWindow?.startsAt ?? null);
  const startsAt =
    eventStart ?? (opening ? t("entryOpensAt", { time: opening }) : null);
  return (
    <li>
      <Link
        className="card ticket-card"
        href={`/products/${slug}/tickets/${ticket.objectId}`}
      >
        <span className="ticket-card-icon" aria-hidden>
          <TicketIcon size={22} />
        </span>
        <span className="ticket-card-copy">
          <strong>{ticket.event.title}</strong>
          {startsAt ? <span>{startsAt}</span> : null}
          {ticket.entryClass ? <span>{ticket.entryClass}</span> : null}
          {entryWindowClosed(ticket) ? (
            <span>{t("windowClosedShort")}</span>
          ) : null}
        </span>
        <TicketStatusBadge status={ticket.status} endedAs={ticket.endedAs} />
        <ChevronRight size={20} aria-hidden />
      </Link>
    </li>
  );
}

/** Announces, and takes focus for, the end of a list the holder paged to. */
function ListComplete({ children }: { children: React.ReactNode }) {
  const ref = useFocusOnMount<HTMLParagraphElement>();
  return (
    <p ref={ref} tabIndex={-1} role="status" className="ticket-list-end">
      {children}
    </p>
  );
}

function TicketList({
  slug,
  programmeName,
  launchId,
}: {
  slug: string;
  programmeName: string;
  launchId: string;
}) {
  const t = useTranslations("tickets");
  const { wallet } = useSession();
  const query = useTickets({ slug, launchId, walletId: wallet?.id });
  // Set only by the holder's own "show more" reaching the last page, so the
  // completion is announced (and focused) only after a load they asked for.
  const [pagedToEnd, setPagedToEnd] = useState(false);
  const tickets = query.data?.pages.flatMap((page) => page.tickets) ?? [];
  const loadingMore = query.isFetchingNextPage;
  async function showMore() {
    if (loadingMore) return;
    const result = await query.fetchNextPage();
    if (!result.isError && !result.hasNextPage) setPagedToEnd(true);
  }
  // A failed first read has nothing to show; a failed later page keeps every
  // ticket already listed and is retried from where it stopped.
  const firstReadFailed = query.isError && !query.data;
  const moreFailed = query.isFetchNextPageError;
  const more =
    query.hasNextPage && !moreFailed ? (
      <div className="load-more">
        {/* aria-disabled, not disabled: the control keeps keyboard focus
            while the next page loads. */}
        <Button
          variant="secondary"
          aria-disabled={loadingMore || undefined}
          onClick={() => void showMore()}
        >
          {loadingMore
            ? t("loadingMore")
            : tickets.length
              ? t("loadMore")
              : t("keepChecking")}
        </Button>
      </div>
    ) : null;
  const sessionEnded =
    query.error instanceof TicketsError &&
    query.error.failure === "session_expired";
  const moreFailure = !moreFailed ? null : sessionEnded ? (
    // An ended session is its own answer: sign in and come back here.
    <TicketsFailure
      error={query.error}
      retry={() => void showMore()}
      returnPath={`/products/${slug}/tickets`}
      takeFocus
    />
  ) : (
    <Alert takeFocus>
      <span>{t("failure.moreUnavailable")}</span>
      <Button variant="secondary" onClick={() => void showMore()}>
        {t("failure.retry")}
      </Button>
    </Alert>
  );
  return (
    <>
      <PageHeader
        eyebrow={programmeName}
        title={t("title")}
        description={t("description")}
      />
      {firstReadFailed ? (
        <TicketsFailure
          error={query.error}
          retry={() => void query.refetch()}
          returnPath={`/products/${slug}/tickets`}
        />
      ) : query.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : tickets.length ? (
        <>
          <ul className="ticket-list">
            {tickets.map((ticket) => (
              <TicketCard key={ticket.objectId} slug={slug} ticket={ticket} />
            ))}
          </ul>
          {moreFailure}
          {more}
          {pagedToEnd && !query.hasNextPage ? (
            <ListComplete>{t("allShown")}</ListComplete>
          ) : null}
        </>
      ) : query.hasNextPage || moreFailed ? (
        // Nothing found in what was read so far, but the read is not
        // finished: never "no tickets" until every page was read.
        <>
          <p role="status">{t("notFoundYet")}</p>
          {moreFailure}
          {more}
        </>
      ) : pagedToEnd ? (
        <ListComplete>{t("emptyTitle")}</ListComplete>
      ) : (
        <EmptyState
          icon={TicketIcon}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
        />
      )}
    </>
  );
}

function TicketDetail({
  slug,
  objectId,
  launchId,
  admission,
}: {
  slug: string;
  objectId: string;
  launchId: string;
  admission: boolean;
}) {
  const t = useTranslations("tickets");
  const { wallet } = useSession();
  const query = useTicket({ slug, launchId, walletId: wallet?.id, objectId });
  const refresh = useRefreshTicket({ slug, walletId: wallet?.id, objectId });
  // When the gate last verified this entry. The header says so only once a
  // Dual read made after that agrees; Dual's own state alone never does.
  const [verifiedAt, setVerifiedAt] = useState<number | null>(null);
  const startsAt = useTicketTime();
  function onOutcome(state: AdmissionState) {
    if (state.status === "admitted") setVerifiedAt(Date.now());
    if (admissionMayHaveWritten(state)) void refresh();
  }
  const back = (
    <Link
      className={buttonClass("secondary")}
      href={`/products/${slug}/tickets`}
    >
      <ChevronLeft size={18} aria-hidden />
      {t("back")}
    </Link>
  );
  if (query.isError) {
    return (
      <>
        <TicketsFailure
          error={query.error}
          retry={() => void query.refetch()}
          returnPath={`/products/${slug}/tickets/${objectId}`}
        />
        <div className="load-more">{back}</div>
      </>
    );
  }
  if (query.isPending) return <p role="status">{t("loading")}</p>;
  const ticket = query.data;
  const when = startsAt(ticket.event.startsAt);
  const status: TicketBadge =
    admission &&
    verifiedAt !== null &&
    query.dataUpdatedAt >= verifiedAt &&
    ticket.status === "admission_recorded"
      ? "entry_confirmed"
      : ticket.status;
  const endedAs = status === "ended" ? ticket.endedAs : null;
  const windowClosed = entryWindowClosed(ticket);
  return (
    <>
      <PageHeader
        eyebrow={t("detailEyebrow")}
        title={ticket.event.title}
        description={t(`statusExplanation.${endedAs ?? status}`)}
        action={<TicketStatusBadge status={status} endedAs={endedAs} />}
      />
      <section className="card ticket-detail" aria-labelledby="ticket-facts">
        <h2 id="ticket-facts">{t("factsTitle")}</h2>
        <dl className="ticket-facts">
          {/* The event's own start, only when the ticket states one. An
              entry window is never shown as it: it is when entry opens and
              closes, below. */}
          <div>
            <dt>{t("eventStarts")}</dt>
            <dd>{when ?? t("notStated")}</dd>
          </div>
          {ticket.entryWindow ? (
            <>
              <div>
                <dt>{t("entryOpens")}</dt>
                <dd>
                  {startsAt(ticket.entryWindow.startsAt) ?? t("notStated")}
                </dd>
              </div>
              <div>
                <dt>{t("entryCloses")}</dt>
                <dd>{startsAt(ticket.entryWindow.endsAt) ?? t("notStated")}</dd>
              </div>
            </>
          ) : null}
          <div>
            <dt>{t("where")}</dt>
            <dd>{ticket.event.venue ?? t("notStated")}</dd>
          </div>
          <div>
            <dt>{t("entryClass")}</dt>
            <dd>{ticket.entryClass ?? t("notStated")}</dd>
          </div>
          {/* With ticket-admission-v1 the binding's issuance path is a
              content hash, not an operation: the original issue operation
              is shown only from the runtime's verified issuance proof. */}
          {admission ? null : (
            <div>
              <dt>{t("issueReference")}</dt>
              <dd>{ticket.issueOperationId ?? t("notRecorded")}</dd>
            </div>
          )}
        </dl>
      </section>
      <section className="card ticket-detail" aria-labelledby="ticket-entry">
        <h2 id="ticket-entry">{t("entryTitle")}</h2>
        {windowClosed && ticket.entryWindow ? (
          <p>
            {t("windowClosed", {
              endsAt: startsAt(ticket.entryWindow.endsAt) ?? "",
            })}
          </p>
        ) : null}
        {ticket.entryGuidance ? <p>{ticket.entryGuidance}</p> : null}
        {/* Without ticket-admission-v1, entry is not part of Tickets,
            whatever the ticket says. */}
        {admission ? null : <p>{t("admissionUnavailable")}</p>}
      </section>
      {admission ? (
        <TicketAdmission
          slug={slug}
          objectId={objectId}
          launchId={launchId}
          recorded={ticket.status === "admission_recorded"}
          noNewEntry={status === "ended" || windowClosed}
          onOutcome={onOutcome}
        />
      ) : null}
      <div className="load-more">{back}</div>
    </>
  );
}

/**
 * The read-only Tickets journey of one programme. The launch id scopes only
 * this tab's BFF reads; nothing is journaled and nothing is written.
 */
export function TicketsView({
  slug,
  programmeName,
  objectId,
  admission = false,
}: {
  slug: string;
  programmeName: string;
  objectId?: string;
  /** The binding states ticket-admission-v1 and this host serves Tickets. */
  admission?: boolean;
}) {
  const [launchId] = useState(newFaceLaunchId);
  return (
    <div className="tickets-view">
      {objectId ? (
        // Keyed: another ticket never inherits this one's entry or pass.
        <TicketDetail
          key={objectId}
          slug={slug}
          objectId={objectId}
          launchId={launchId}
          admission={admission}
        />
      ) : (
        <TicketList
          slug={slug}
          programmeName={programmeName}
          launchId={launchId}
        />
      )}
    </div>
  );
}

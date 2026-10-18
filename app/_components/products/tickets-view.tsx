"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Ticket as TicketIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Alert } from "@/app/_components/design-system/alert";
import { Button, buttonClass } from "@/app/_components/design-system/button";
import { EmptyState } from "@/app/_components/design-system/empty-state";
import { PageHeader } from "@/app/_components/design-system/page-header";
import { newFaceLaunchId } from "@/app/_domain/product-face";
import type { Ticket, TicketStatus } from "@/app/_domain/tickets";
import { useTicket, useTickets } from "@/app/_hooks/use-tickets";
import { useSession } from "@/app/_providers/session-provider";
import { TicketsError } from "@/app/_services/tickets.client";

const statusTone: Record<TicketStatus, string> = {
  issued: "status-completed",
  pending: "status-pending",
  ended: "status-neutral",
  unconfirmed: "status-neutral",
};

function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const t = useTranslations("tickets.status");
  return <span className={`status ${statusTone[status]}`}>{t(status)}</span>;
}

function useStartsAt() {
  const format = useFormatter();
  return (value: string | null) =>
    value
      ? format.dateTime(new Date(value), {
          dateStyle: "full",
          timeStyle: "short",
        })
      : null;
}

/** What a failed read means for the holder, and what they can do next. */
function TicketsFailure({
  error,
  retry,
  returnPath,
}: {
  error: unknown;
  retry: () => void;
  returnPath: string;
}) {
  const t = useTranslations("tickets.failure");
  const failure = error instanceof TicketsError ? error.failure : "unavailable";
  if (failure === "session_expired") {
    return (
      <Alert>
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
  const startsAt = useStartsAt()(ticket.event.startsAt);
  return (
    <li>
      <Link
        className="card ticket-card"
        href={`/products/${slug}/tickets/${ticket.objectId}`}
        aria-label={t("open", { event: ticket.event.title })}
      >
        <span className="ticket-card-icon" aria-hidden>
          <TicketIcon size={22} />
        </span>
        <span className="ticket-card-copy">
          <strong>{ticket.event.title}</strong>
          {startsAt ? <span>{startsAt}</span> : null}
          {ticket.entryClass ? <span>{ticket.entryClass}</span> : null}
        </span>
        <TicketStatusBadge status={ticket.status} />
        <ChevronRight size={20} aria-hidden />
      </Link>
    </li>
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
  const tickets = query.data?.pages.flatMap((page) => page.tickets) ?? [];
  return (
    <>
      <PageHeader
        eyebrow={programmeName}
        title={t("title")}
        description={t("description")}
      />
      {query.isError ? (
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
          {query.hasNextPage ? (
            <div className="load-more">
              <Button
                variant="secondary"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t("loadMore")}
              </Button>
            </div>
          ) : null}
        </>
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
}: {
  slug: string;
  objectId: string;
  launchId: string;
}) {
  const t = useTranslations("tickets");
  const { wallet } = useSession();
  const query = useTicket({ slug, launchId, walletId: wallet?.id, objectId });
  const startsAt = useStartsAt();
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
  return (
    <>
      <PageHeader
        eyebrow={t("detailEyebrow")}
        title={ticket.event.title}
        description={t(`statusExplanation.${ticket.status}`)}
        action={<TicketStatusBadge status={ticket.status} />}
      />
      <section className="card ticket-detail" aria-labelledby="ticket-facts">
        <h2 id="ticket-facts">{t("factsTitle")}</h2>
        <dl className="ticket-facts">
          <div>
            <dt>{t("when")}</dt>
            <dd>{when ?? t("notStated")}</dd>
          </div>
          <div>
            <dt>{t("where")}</dt>
            <dd>{ticket.event.venue ?? t("notStated")}</dd>
          </div>
          <div>
            <dt>{t("entryClass")}</dt>
            <dd>{ticket.entryClass ?? t("notStated")}</dd>
          </div>
          <div>
            <dt>{t("issueReference")}</dt>
            <dd>{ticket.issueOperationId ?? t("notRecorded")}</dd>
          </div>
        </dl>
      </section>
      <section className="card ticket-detail" aria-labelledby="ticket-entry">
        <h2 id="ticket-entry">{t("entryTitle")}</h2>
        {ticket.entryGuidance ? <p>{ticket.entryGuidance}</p> : null}
        {/* Admission is not part of Tickets yet, whatever the ticket says. */}
        <p>{t("admissionUnavailable")}</p>
      </section>
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
}: {
  slug: string;
  programmeName: string;
  objectId?: string;
}) {
  const [launchId] = useState(newFaceLaunchId);
  return (
    <div className="tickets-view">
      {objectId ? (
        <TicketDetail slug={slug} objectId={objectId} launchId={launchId} />
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

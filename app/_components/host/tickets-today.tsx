"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Alert } from "@/app/_components/design-system/alert";
import { Button } from "@/app/_components/design-system/button";
import { TicketStatusBadge } from "@/app/_components/products/tickets-view";
import { newFaceLaunchId } from "@/app/_domain/product-face";
import type { Ticket } from "@/app/_domain/tickets";
import { ticketsToday } from "@/app/_domain/tickets-today";
import { sessionQueryOptions } from "@/app/_hooks/query-options";
import { useTickets } from "@/app/_hooks/use-tickets";
import { useSession } from "@/app/_providers/session-provider";
import { TicketsError } from "@/app/_services/tickets.client";

/** The viewer's own IANA time zone: "Today" and every time shown use it. */
function viewerTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function TicketLine({
  ticket,
  href,
  timeZone,
}: {
  ticket: Ticket;
  href: string;
  timeZone: string;
}) {
  const format = useFormatter();
  const when = ticket.event.startsAt
    ? format.dateTime(new Date(ticket.event.startsAt), {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
        timeZone,
      })
    : null;
  return (
    <li>
      {/* The link's name is its visible content: event, time and status. */}
      <Link className="card ticket-card" href={href}>
        <span className="ticket-card-copy">
          <strong>{ticket.event.title}</strong>
          {when ? <span>{when}</span> : null}
          {ticket.event.venue ? <span>{ticket.event.venue}</span> : null}
        </span>
        <TicketStatusBadge status={ticket.status} />
        <ChevronRight size={20} aria-hidden />
      </Link>
    </li>
  );
}

function Section({
  id,
  title,
  tickets,
  slug,
  timeZone,
}: {
  id: string;
  title: string;
  tickets: Ticket[];
  slug: string;
  timeZone: string;
}) {
  if (!tickets.length) return null;
  return (
    <section className="tickets-today-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <ul className="ticket-list">
        {tickets.map((ticket) => (
          <TicketLine
            key={ticket.objectId}
            ticket={ticket}
            href={`/products/${slug}/tickets/${ticket.objectId}`}
            timeZone={timeZone}
          />
        ))}
      </ul>
    </section>
  );
}

function TodayTickets({
  slug,
  href,
  walletId,
}: {
  slug: string;
  href: string;
  walletId: string;
}) {
  const t = useTranslations("host.today");
  const [launchId] = useState(newFaceLaunchId);
  const [timeZone] = useState(viewerTimeZone);
  // One instant per visit: "Today" does not shift between renders.
  const [now] = useState(() => new Date());
  // The first Tickets page only: the home never pages on its own.
  const query = useTickets({ slug, launchId, walletId });
  const seeAll = (
    <p className="tickets-today-all">
      <Link href={href}>{t("seeAll")}</Link>
    </p>
  );
  if (query.isPending) return <p role="status">{t("loading")}</p>;
  if (query.isError) {
    const failure =
      query.error instanceof TicketsError ? query.error.failure : null;
    if (failure === "session_expired") {
      return (
        <Alert>
          <span>
            {t("sessionExpired")}{" "}
            {/* Sign-in on a branded host returns to this home. */}
            <a href="/login">{t("signIn")}</a>
          </span>
        </Alert>
      );
    }
    return (
      <Alert>
        <span>{t("unavailable")}</span>
        {failure === "capability_not_granted" ? null : (
          <Button variant="secondary" onClick={() => void query.refetch()}>
            {t("retry")}
          </Button>
        )}
      </Alert>
    );
  }
  const first = query.data.pages[0];
  const view = ticketsToday(first.tickets, {
    now,
    timeZone,
    partial: first.next !== null,
  });
  const nothingShown =
    !view.today.length && !view.comingUp.length && !view.attention.length;
  return (
    <>
      <Section
        id="tickets-today-now"
        title={t("today")}
        tickets={view.today}
        slug={slug}
        timeZone={timeZone}
      />
      <Section
        id="tickets-today-coming"
        title={t("comingUp")}
        tickets={view.comingUp}
        slug={slug}
        timeZone={timeZone}
      />
      <Section
        id="tickets-today-attention"
        title={t("attention")}
        tickets={view.attention}
        slug={slug}
        timeZone={timeZone}
      />
      {nothingShown ? (
        <p role="status">
          {first.tickets.length
            ? t("nothingDated")
            : view.partial
              ? t("notFoundYet")
              : t("none")}
        </p>
      ) : null}
      {view.partial ? (
        <p className="tickets-today-note">{t("partial")}</p>
      ) : null}
      {seeAll}
    </>
  );
}

/**
 * The signed-in home's Today section for one Tickets face. Nothing private is
 * fetched or shown until the session read confirms a signed-in wallet; the
 * session cookie only decides that this island is mounted at all. Every read
 * goes through the Tickets BFF, which re-checks session, holder, client and
 * programme.
 */
export function TicketsTodaySection({
  slug,
  href,
}: {
  slug: string;
  href: string;
}) {
  const t = useTranslations("host.today");
  const { wallet, isAuthenticated, onSessionEnd } = useSession();
  // Every session end (logout, expiry, account change) is followed by the
  // provider clearing the account's queries; reading afresh after it means a
  // read never belongs to, or is cancelled with, the session that ended.
  const [generation, setGeneration] = useState(0);
  useEffect(
    () => onSessionEnd(() => setGeneration((value) => value + 1)),
    [onSessionEnd],
  );
  // The session read's own pending state (the same deduplicated query the
  // provider holds): pending on the server render and on the first client
  // render alike, so both render nothing and nothing private is guessed.
  const session = useQuery(sessionQueryOptions());
  if (session.isPending) return null;
  if (!isAuthenticated || !wallet) {
    return (
      <section className="tickets-today" aria-labelledby="tickets-today">
        <h2 id="tickets-today">{t("title")}</h2>
        <p>
          {t("signedOut")} <a href="/login">{t("signIn")}</a>
        </p>
      </section>
    );
  }
  return (
    <section className="tickets-today" aria-labelledby="tickets-today">
      <h2 id="tickets-today">{t("title")}</h2>
      {/* Keyed by wallet and session generation: another account's or an
          ended session's tickets never render here. */}
      <TodayTickets
        key={`${wallet.id}:${generation}`}
        slug={slug}
        href={href}
        walletId={wallet.id}
      />
    </section>
  );
}

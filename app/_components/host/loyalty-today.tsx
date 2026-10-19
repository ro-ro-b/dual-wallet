"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Alert } from "@/app/_components/design-system/alert";
import { Button } from "@/app/_components/design-system/button";
import { newFaceLaunchId } from "@/app/_domain/product-face";
import { sessionQueryOptions } from "@/app/_hooks/query-options";
import { useLoyaltyMembership } from "@/app/_hooks/use-loyalty";
import { useSession } from "@/app/_providers/session-provider";
import { LoyaltyError } from "@/app/_services/loyalty.client";

function MembershipCard({
  slug,
  href,
  walletId,
}: {
  slug: string;
  href: string;
  walletId: string;
}) {
  const t = useTranslations("host.loyalty");
  const status = useTranslations("loyalty.status");
  const [launchId] = useState(newFaceLaunchId);
  const query = useLoyaltyMembership({ slug, launchId, walletId });
  if (query.isPending) return <p role="status">{t("loading")}</p>;
  if (query.isError) {
    const expired =
      query.error instanceof LoyaltyError &&
      query.error.code === "session_expired";
    return (
      <Alert>
        <span>
          {expired ? (
            <>
              {t("sessionExpired")} <a href="/login">{t("signIn")}</a>
            </>
          ) : (
            t("unavailable")
          )}
        </span>
        {expired ? null : (
          <Button variant="secondary" onClick={() => void query.refetch()}>
            {t("retry")}
          </Button>
        )}
      </Alert>
    );
  }
  const view = query.data.membership;
  return (
    <>
      {/* Only what the BFF proved now; never points or a tier. */}
      <p role="status">
        {view.status === "none" ? t("notJoined") : status(view.status)}
      </p>
      <p className="tickets-today-all">
        <Link href={href}>
          {view.status === "none" ? t("join") : t("open")}
        </Link>
      </p>
    </>
  );
}

/**
 * The signed-in home's membership card for one Loyalty face. As for Today's
 * tickets, nothing private is read until the session read confirms a
 * signed-in wallet, and every read goes through the Loyalty BFF.
 */
export function LoyaltyTodaySection({
  slug,
  href,
}: {
  slug: string;
  href: string;
}) {
  const t = useTranslations("host.loyalty");
  const { wallet, isAuthenticated, onSessionEnd } = useSession();
  const [generation, setGeneration] = useState(0);
  useEffect(
    () => onSessionEnd(() => setGeneration((value) => value + 1)),
    [onSessionEnd],
  );
  const session = useQuery(sessionQueryOptions());
  if (session.isPending || !isAuthenticated || !wallet) return null;
  return (
    <section className="tickets-today" aria-labelledby="loyalty-today">
      <h2 id="loyalty-today">{t("title")}</h2>
      <MembershipCard
        key={`${wallet.id}:${generation}`}
        slug={slug}
        href={href}
        walletId={wallet.id}
      />
    </section>
  );
}

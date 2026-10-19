import Link from "next/link";
import { useTranslations } from "next-intl";
import { buttonClass } from "@/app/_components/design-system/button";
import { Brand } from "@/app/_components/design-system/brand";
import type { HostHomeView } from "@/app/_domain/wallet-host";

/** The public home's navigation: an honest way to sign in or join. */
export function HostHomeSignedOutNav() {
  const t = useTranslations("host");
  return (
    <nav className="host-home-nav" aria-label={t("homeNavigation")}>
      <Link href="/login" className="host-home-link">
        {t("signIn")}
      </Link>
      <Link href="/register" className="host-home-link">
        {t("createAccount")}
      </Link>
    </nav>
  );
}

/**
 * A branded host's home: its validated headline and introduction, its primary
 * journey and its other enabled journeys. Only enabled, backed journeys and
 * allowlisted navigation entries reach it. It shows nothing private itself:
 * the only private content is in the `account` and `today` islands, which
 * show anything only after their own session read.
 */
export function HostHome({
  home,
  account = null,
  today = null,
}: {
  home: HostHomeView;
  /**
   * The header's signed-in navigation, verified account and sign-out (a
   * client island: app/_components/host/host-home-account.tsx); null on the
   * public home, which offers sign-in instead.
   */
  account?: React.ReactNode;
  /**
   * The signed-in Today section (a client island that reads the holder's
   * own tickets after its session read); null on the public home.
   */
  today?: React.ReactNode;
}) {
  const t = useTranslations("host");
  return (
    <div className="host-home">
      <header className="host-home-header">
        <Brand host={home.brand} />
        {account ?? <HostHomeSignedOutNav />}
      </header>
      <main id="main-content" className="host-home-main">
        <h1 className="host-home-headline">{home.headline}</h1>
        {today}
        <p className="host-home-introduction">{home.introduction}</p>
        <p className="host-home-primary">
          <Link href={home.primary.href} className={buttonClass("primary")}>
            {t(`journeys.${home.primary.journey}`)}
          </Link>
        </p>
        {home.journeys.length ? (
          <ul className="host-home-journeys" aria-label={t("journeysLabel")}>
            {home.journeys.map(({ journey, href }) => (
              <li key={journey}>
                <Link href={href} className={buttonClass("secondary")}>
                  {t(`journeys.${journey}`)}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </div>
  );
}

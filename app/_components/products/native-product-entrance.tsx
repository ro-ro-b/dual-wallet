import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonClass } from "@/app/_components/design-system/button";
import { PageHeader } from "@/app/_components/design-system/page-header";
import {
  hostJourneyTasks,
  type NativeHostJourney,
} from "@/app/_domain/wallet-host";

export type NativeProductRoute = "home" | "support" | "ended";

/**
 * The entrance, help and end pages of a native-only face (Tickets, Loyalty):
 * wallet pages, not a frame. They read nothing and claim nothing about the
 * holder's tickets or membership; they say where those are kept and link to
 * the face's own native journeys and the brand's Home. The copy is the
 * configured brand's and the binding's programme name only.
 */
export async function NativeProductEntrance({
  route,
  slug,
  programmeName,
  brand,
  journeys,
}: {
  route: NativeProductRoute;
  slug: string;
  programmeName: string;
  brand: { name: string; description: string };
  journeys: readonly NativeHostJourney[];
}) {
  const t = await getTranslations("productEntrance");
  const header = {
    home: {
      eyebrow: brand.name,
      title: programmeName,
      description: t("homeDescription"),
    },
    support: {
      eyebrow: programmeName,
      title: t("supportTitle"),
      description: brand.description,
    },
    ended: {
      eyebrow: programmeName,
      title: t("endedTitle"),
      description: t("endedDescription", { programme: programmeName }),
    },
  }[route];
  return (
    <>
      <PageHeader {...header} />
      {journeys.map((journey) => (
        <section key={journey} className="card native-entrance">
          <p>{t(`where.${journey}`, { programme: programmeName })}</p>
          <div className="native-entrance-actions">
            <Link
              className={buttonClass("primary")}
              href={`/products/${slug}${hostJourneyTasks[journey]}`}
            >
              {t(`open.${journey}`)}
            </Link>
          </div>
        </section>
      ))}
      <div className="native-entrance-actions">
        <Link className={buttonClass("secondary")} href="/">
          {t("home", { brand: brand.name })}
        </Link>
      </div>
    </>
  );
}

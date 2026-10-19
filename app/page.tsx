import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/api/settings";
import { hostHome, hostPresentation } from "@/api/wallet-host";
import { HostHome } from "@/app/_components/host/host-home";
import { LoyaltyTodaySection } from "@/app/_components/host/loyalty-today";
import { TicketsTodaySection } from "@/app/_components/host/tickets-today";
import { Providers } from "@/app/_providers/providers";

export default async function Home() {
  const cookieStore = await cookies();
  // Presentation only: whether to show signed-in navigation and to mount the
  // Today island. It is never authority; the island's session read and the
  // Tickets BFF decide what, if anything, private is shown.
  const signedIn = cookieStore.has(SESSION_COOKIE_NAME);
  // A branded host renders its configured home; the generic wallet goes
  // straight to inventory or sign-in, as it always has.
  const home = hostHome();
  if (home) {
    const today =
      signedIn && (home.tickets || home.loyalty) ? (
        <Providers host={hostPresentation()}>
          {home.tickets ? (
            <TicketsTodaySection
              slug={home.tickets.slug}
              href={home.tickets.href}
            />
          ) : null}
          {home.loyalty ? (
            <LoyaltyTodaySection
              slug={home.loyalty.slug}
              href={home.loyalty.href}
            />
          ) : null}
        </Providers>
      ) : null;
    return <HostHome home={home} signedIn={signedIn} today={today} />;
  }
  redirect(signedIn ? "/inventory" : "/login");
}

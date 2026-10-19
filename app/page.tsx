import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/api/settings";
import { hostHome, hostPresentation } from "@/api/wallet-host";
import { HostHome } from "@/app/_components/host/host-home";
import { HostHomeAccount } from "@/app/_components/host/host-home-account";
import { LoyaltyTodaySection } from "@/app/_components/host/loyalty-today";
import { TicketsTodaySection } from "@/app/_components/host/tickets-today";
import { Providers } from "@/app/_providers/providers";

export default async function Home() {
  const cookieStore = await cookies();
  // Presentation only: whether to mount the signed-in islands (the header's
  // account and Today). It is never authority or identity; each island's
  // session read, and the BFFs behind it, decide what, if anything, private
  // is shown. Without the cookie the home is the public one and reads nothing.
  const signedIn = cookieStore.has(SESSION_COOKIE_NAME);
  // A branded host renders its configured home; the generic wallet goes
  // straight to inventory or sign-in, as it always has.
  const home = hostHome();
  if (home) {
    if (!signedIn) return <HostHome home={home} />;
    // One provider tree for every island: one session read, one cache, so a
    // sign-out from the header ends Today with it.
    return (
      <Providers host={hostPresentation()}>
        <HostHome
          home={home}
          account={<HostHomeAccount navigation={home.navigation} />}
          today={
            home.tickets || home.loyalty ? (
              <>
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
              </>
            ) : null
          }
        />
      </Providers>
    );
  }
  redirect(signedIn ? "/inventory" : "/login");
}

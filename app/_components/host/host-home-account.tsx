"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert } from "@/app/_components/design-system/alert";
import { HostHomeSignedOutNav } from "@/app/_components/host/host-home";
import { UserProfileMenu } from "@/app/_components/user-profile-menu";
import type { HostHomeView } from "@/app/_domain/wallet-host";
import { sessionQueryOptions } from "@/app/_hooks/query-options";
import { useSession } from "@/app/_providers/session-provider";

/**
 * The signed-in home's header: the host's navigation, the verified account
 * (the wallet shell's own profile menu) and sign-out. The session cookie only
 * decides that this island is mounted; what it shows comes from the session
 * read. While that read is pending (the server render and the first client
 * render alike) it shows nothing, so no identity is guessed. A cookie that
 * names no live session gets the public home's sign-in.
 *
 * Signing out withholds the account at once, before the session is revoked
 * (the Today islands hear the same "logout" notice), then re-renders the home
 * as the public one. The provider has already cleared every cached account
 * query by then, so nothing of this account reaches the next.
 */
export function HostHomeAccount({
  navigation,
}: {
  navigation: HostHomeView["navigation"];
}) {
  const t = useTranslations("host");
  const nav = useTranslations("nav");
  const router = useRouter();
  const { wallet, isAuthenticated, logout } = useSession();
  const session = useQuery(sessionQueryOptions());
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setFailed(false);
    try {
      await logout();
    } catch {
      // Still signed in: the account comes back with the failure said.
      setSigningOut(false);
      setFailed(true);
      return;
    }
    router.refresh();
  }

  if (signingOut) {
    return (
      <p className="host-home-status" role="status">
        {t("signingOut")}
      </p>
    );
  }
  if (session.isPending) return null;
  if (!isAuthenticated || !wallet) return <HostHomeSignedOutNav />;
  return (
    <div className="host-home-session">
      <nav className="host-home-nav" aria-label={t("homeNavigation")}>
        {navigation.map(({ entry, href }) => (
          <Link key={entry} href={href} className="host-home-link">
            {nav(entry)}
          </Link>
        ))}
      </nav>
      <div className="host-home-account">
        <UserProfileMenu wallet={wallet} />
        <button
          className="host-home-link"
          type="button"
          onClick={() => void signOut()}
        >
          <LogOut size={19} aria-hidden />
          {nav("logout")}
        </button>
      </div>
      {failed ? (
        <Alert>
          <span>{t("signOutFailed")}</span>
        </Alert>
      ) : null}
    </div>
  );
}

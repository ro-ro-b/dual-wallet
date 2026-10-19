"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Boxes,
  LogOut,
  Menu,
  Moon,
  PackageCheck,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Brand } from "@/app/_components/design-system/brand";
import { UserProfileMenu } from "@/app/_components/user-profile-menu";
import { safeReturnPath } from "@/app/_domain/navigation";
import { useHostPresentation } from "@/app/_providers/host-provider";
import { useSession } from "@/app/_providers/session-provider";
import { useTheme } from "@/app/_providers/theme-provider";
import { cn } from "@/app/_utils/cn";

const links = [
  { href: "/inventory", key: "inventory", icon: Boxes },
  { href: "/products", key: "products", icon: PackageCheck },
  { href: "/activity", key: "activity", icon: Activity },
  { href: "/settings", key: "settings", icon: Settings },
] as const;

type NavLink = (typeof links)[number];

function Nav({ close, entries }: { close?: () => void; entries: NavLink[] }) {
  const pathname = usePathname();
  const t = useTranslations("nav");
  return (
    <>
      {entries.map(({ href, key, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={close}
            className={cn("nav-link", active && "nav-link-active")}
            aria-current={active ? "page" : undefined}
          >
            <Icon size={19} aria-hidden />
            {t(key)}
          </Link>
        );
      })}
    </>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { wallet, isLoading, isAuthenticated, logout } = useSession();
  const { theme, toggleTheme } = useTheme();
  // A branded host renders one validated palette, so it offers no theme
  // switch.
  const host = useHostPresentation();
  // A branded host shows exactly its configured entries, in its order.
  const entries: NavLink[] = host
    ? host.navigation.flatMap((key) => links.filter((link) => link.key === key))
    : [...links];
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const signingOut = useRef(false);
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("nav");
  const common = useTranslations("common");
  // A programme's product face uses the whole content area.
  const fullSize = /^\/products\/[^/]+/.test(pathname);
  // A branded host's identity is the way back to its Today-first Home; the
  // generic wallet has no such Home ("/" goes straight to inventory).
  const homeHref = host ? "/" : undefined;

  useEffect(() => {
    if (isLoading || isAuthenticated) return;
    // An expired session returns here after sign-in; an explicit sign-out
    // replaces this with a plain /login below.
    const next = signingOut.current
      ? undefined
      : safeReturnPath(`${window.location.pathname}${window.location.search}`);
    router.replace(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  }, [isAuthenticated, isLoading, router]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileOpen(false);
      menuTrigger.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  const signOut = async () => {
    signingOut.current = true;
    await logout();
    router.replace("/login");
    router.refresh();
  };

  const themeButton = host ? null : (
    <button className="nav-link" type="button" onClick={toggleTheme}>
      {theme === "dark" ? (
        <Sun size={19} aria-hidden />
      ) : (
        <Moon size={19} aria-hidden />
      )}
      {common("theme")}
    </button>
  );
  const signOutButton = (
    <button className="nav-link" type="button" onClick={signOut}>
      <LogOut size={19} aria-hidden />
      {t("logout")}
    </button>
  );

  return (
    <div className="app-layout">
      <a className="skip-link" href="#main-content">
        {common("skipToContent")}
      </a>
      <aside className="sidebar">
        <Brand host={host} home={homeHref} />
        <nav className="sidebar-nav" aria-label={t("mainNavigation")}>
          <Nav entries={entries} />
        </nav>
        <div className="sidebar-footer">
          {themeButton}
          {signOutButton}
          {wallet ? <UserProfileMenu wallet={wallet} /> : null}
        </div>
      </aside>
      <div className="main">
        <header className="mobile-topbar">
          <Brand host={host} home={homeHref} />
          <button
            ref={menuTrigger}
            className="icon-button"
            type="button"
            aria-label={common(mobileOpen ? "closeMenu" : "openMenu")}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
            onClick={() => setMobileOpen((value) => !value)}
          >
            {mobileOpen ? (
              <X size={20} aria-hidden />
            ) : (
              <Menu size={20} aria-hidden />
            )}
          </button>
        </header>
        {mobileOpen ? (
          <nav
            id="mobile-nav"
            className="mobile-nav"
            aria-label={t("mainNavigation")}
          >
            <Nav entries={entries} close={() => setMobileOpen(false)} />
            {themeButton}
            {signOutButton}
          </nav>
        ) : null}
        <main
          className={cn("content", fullSize && "content-full")}
          id="main-content"
          tabIndex={-1}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

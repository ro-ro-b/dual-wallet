import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { HostPresentation } from "@/app/_domain/wallet-host";

/**
 * The wallet's mark and name. A branded host passes its own (validated name,
 * content-addressed logo served from the pinned bytes); without one the
 * generic wallet's are used. With `home`, the mark and name are the link
 * back to that Home, named for it.
 */
export function Brand({
  inverse = false,
  host = null,
  home,
}: {
  inverse?: boolean;
  host?: Pick<HostPresentation, "brand" | "logo"> | null;
  home?: string;
}) {
  const t = useTranslations("common");
  const name = host ? host.brand.name : t("brand");
  const className = inverse ? "brand brand-inverse" : "brand";
  const identity = (
    <>
      {host ? (
        <Image
          className="brand-mark"
          src={host.logo.src}
          alt=""
          width={34}
          height={34}
          aria-hidden
          unoptimized
        />
      ) : (
        <Image
          className="brand-mark"
          src="/favicon.svg"
          alt=""
          width={34}
          height={34}
          aria-hidden
        />
      )}
      <span>{name}</span>
    </>
  );
  return home ? (
    <Link
      href={home}
      className={`${className} brand-home`}
      aria-label={t("brandHome", { name })}
    >
      {identity}
    </Link>
  ) : (
    <span className={className}>{identity}</span>
  );
}

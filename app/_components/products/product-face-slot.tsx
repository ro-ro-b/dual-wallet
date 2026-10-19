"use client";

import { useSelectedLayoutSegment } from "next/navigation";
import { ProductFaceHost } from "@/app/_components/products/product-face-host";

/**
 * The programme's face frame, except on the wallet-native Tickets and
 * Loyalty pages (`/products/<slug>/tickets…`, `/products/<slug>/loyalty`),
 * which are their own static route segments and render no frame at all:
 * nothing of the face is loaded for them, and leaving one ends the frame's
 * channel as any unmount does.
 */
export function ProductFaceSlot({ slug }: { slug: string }) {
  const segment = useSelectedLayoutSegment();
  if (segment === "tickets" || segment === "loyalty") return null;
  return <ProductFaceHost slug={slug} />;
}

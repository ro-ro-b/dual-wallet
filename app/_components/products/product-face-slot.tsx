"use client";

import { useSelectedLayoutSegment } from "next/navigation";
import { ProductFaceHost } from "@/app/_components/products/product-face-host";

/**
 * The programme's face frame, except on the wallet-native Tickets pages
 * (`/products/<slug>/tickets…`), which are their own static route segment and
 * render no frame at all: nothing of the face is loaded for a read-only
 * ticket view, and leaving it ends the frame's channel as any unmount does.
 */
export function ProductFaceSlot({ slug }: { slug: string }) {
  if (useSelectedLayoutSegment() === "tickets") return null;
  return <ProductFaceHost slug={slug} />;
}

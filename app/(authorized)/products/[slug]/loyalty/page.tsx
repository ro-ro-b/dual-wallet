import { notFound } from "next/navigation";
import { productFaceBinding } from "@/api/product-face-registry";
import { loyaltyServedBy } from "@/api/wallet-host";
import { LoyaltyView } from "@/app/_components/products/loyalty-view";

export const dynamic = "force-dynamic";

// The wallet-native Loyalty journey of one programme (loyalty-join-earn-v1):
// /products/<slug>/loyalty. Only a branded host that enabled Loyalty, for a
// face of its own whose binding carries the loyalty block, serves it;
// everything else is not found.
export default async function LoyaltyPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const binding = productFaceBinding(slug);
  if (!binding || !loyaltyServedBy(binding)) notFound();
  return <LoyaltyView slug={slug} programmeName={binding.programmeName} />;
}

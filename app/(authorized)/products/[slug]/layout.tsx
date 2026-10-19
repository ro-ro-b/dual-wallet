import { notFound } from "next/navigation";
import { productFaceBinding } from "@/api/product-face-registry";
import { nativeOnlyJourneys } from "@/api/wallet-host";
import { ProductFaceSlot } from "@/app/_components/products/product-face-slot";

export const dynamic = "force-dynamic";

// The host lives in the layout so moving between task paths keeps the same
// frame and channel; only the (empty) task page segment changes. A
// native-only face (Tickets, Loyalty: api/wallet-host.ts nativeOnlyJourneys)
// has no frame on any of its pages, so nothing of its artifact is loaded.
export default async function ProductFaceLayout({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: React.ReactNode;
}) {
  const { slug } = await params;
  const binding = productFaceBinding(slug);
  if (!binding) notFound();
  return (
    <>
      {nativeOnlyJourneys(binding) ? null : <ProductFaceSlot slug={slug} />}
      {children}
    </>
  );
}

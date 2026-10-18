import { notFound } from "next/navigation";
import { productFaceBinding } from "@/api/product-face-registry";
import { ProductFaceSlot } from "@/app/_components/products/product-face-slot";

export const dynamic = "force-dynamic";

// The host lives in the layout so moving between task paths keeps the same
// frame and channel; only the (empty) task page segment changes.
export default async function ProductFaceLayout({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: React.ReactNode;
}) {
  const { slug } = await params;
  if (!productFaceBinding(slug)) notFound();
  return (
    <>
      <ProductFaceSlot slug={slug} />
      {children}
    </>
  );
}

import { notFound, redirect } from "next/navigation";
import { productFaceBinding } from "@/api/product-face-registry";
import { ticketsServedBy } from "@/api/wallet-host";
import { TicketsView } from "@/app/_components/products/tickets-view";
import { isObjectId } from "@/app/_domain/product-face";

export const dynamic = "force-dynamic";

// The wallet-native, read-only Tickets journey of one programme:
// /products/<slug>/tickets and /products/<slug>/tickets/<object id>. Only a
// branded host that enabled Tickets, for a face of its own whose binding
// declares ticket rules, serves it; everything else is not found. The URL is
// the whole state, so a reload or reopen lands on the same ticket.
export default async function TicketsPage({
  params,
}: {
  params: Promise<{ slug: string; ticket?: string[] }>;
}) {
  const { slug, ticket } = await params;
  const binding = productFaceBinding(slug);
  if (!binding || !ticketsServedBy(binding)) notFound();
  if (!ticket?.length) {
    return <TicketsView slug={slug} programmeName={binding.programmeName} />;
  }
  const objectId = ticket.length === 1 ? ticket[0] : undefined;
  if (!isObjectId(objectId)) redirect(`/products/${slug}/tickets`);
  return (
    <TicketsView
      slug={slug}
      programmeName={binding.programmeName}
      objectId={objectId}
      admission={Boolean(binding.tickets?.admission)}
    />
  );
}

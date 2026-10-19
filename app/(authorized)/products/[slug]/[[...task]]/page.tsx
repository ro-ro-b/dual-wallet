import { notFound, redirect } from "next/navigation";
import { productFaceBinding } from "@/api/product-face-registry";
import {
  activeHostConfiguration,
  hostPageAllowed,
  nativeOnlyJourneys,
} from "@/api/wallet-host";
import {
  NativeProductEntrance,
  type NativeProductRoute,
} from "@/app/_components/products/native-product-entrance";
import { isTaskPath, productTaskHref } from "@/app/_domain/product-face";
import { hostJourneyTasks } from "@/app/_domain/wallet-host";

const NATIVE_ROUTES = new Map<string, NativeProductRoute>([
  ["/", "home"],
  ["/home", "home"],
  ["/support", "support"],
  ["/ended", "ended"],
]);

// A stable task link: /products/<slug>/<task path>. Anything that is not a
// valid task path goes back to the programme entry.
export default async function ProductTaskPage({
  params,
}: {
  params: Promise<{ slug: string; task?: string[] }>;
}) {
  const { slug, task } = await params;
  const path = task?.length
    ? `/${task.map((segment) => decodeURIComponent(segment)).join("/")}`
    : "/";
  if (!isTaskPath(path)) redirect(`/products/${slug}`);
  // A branded host serves no task of a disabled journey (the request proxy
  // already answers it 404; this is the page's own check).
  if (!hostPageAllowed(productTaskHref(slug, path))) notFound();
  // Every other face's task page is its frame's (the layout's).
  const binding = productFaceBinding(slug);
  const journeys = binding && nativeOnlyJourneys(binding);
  const configuration = activeHostConfiguration();
  if (!binding || !journeys || !configuration) return null;
  // A native-only face: its entrance is its native journey (or, serving
  // both, a choice of them); help and its end state are native pages; any
  // deeper path under them goes back to the entrance.
  const route = NATIVE_ROUTES.get(path);
  if (!route) redirect(`/products/${slug}`);
  if (route === "home" && journeys.length === 1) {
    redirect(`/products/${slug}${hostJourneyTasks[journeys[0]]}`);
  }
  return (
    <NativeProductEntrance
      route={route}
      slug={slug}
      programmeName={binding.programmeName}
      brand={configuration.brand}
      journeys={journeys}
    />
  );
}

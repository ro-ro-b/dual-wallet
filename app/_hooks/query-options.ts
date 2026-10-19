"use client";

import {
  infiniteQueryOptions,
  queryOptions,
  skipToken,
} from "@tanstack/react-query";
import { queryKeys } from "@/app/_hooks/query-keys";
import {
  getInventoryObject,
  listActivityPage,
  listInventoryPage,
} from "@/app/_services/inventory.client";
import { loadProductFaceContext } from "@/app/_services/product-face.client";
import { loadSession } from "@/app/_services/session.client";
import { getTicket, listTicketsPage } from "@/app/_services/tickets.client";
import { readMembership, readProgramme } from "@/app/_services/loyalty.client";

// ponytail: one fixed interval, no server-driven expiry hint. Shorten this if
// the API refresh-token lifetime ever drops below ~10 minutes.
const SESSION_KEEPALIVE_MS = 5 * 60_000;

export function sessionQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.session.all,
    queryFn: ({ signal }) => loadSession({ signal }),
    retry: false,
    staleTime: 30_000,
    // The server only renews the tokens when a request arrives. An idle tab
    // makes no requests, so the refresh token expires and the next click lands
    // on a dead session. Poll well inside that window to keep it rolling, and
    // keep polling in a hidden tab because that is exactly where this bites.
    refetchInterval: SESSION_KEEPALIVE_MS,
    refetchIntervalInBackground: true,
  });
}

export function inventoryQueryOptions(search: string, owner?: string) {
  return infiniteQueryOptions({
    queryKey: queryKeys.inventory.list({ search, owner }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listInventoryPage({ search, owner, cursor: pageParam, signal }),
    getNextPageParam: (page) => page.next,
  });
}

export function inventoryObjectQueryOptions(objectId: string) {
  return queryOptions({
    queryKey: queryKeys.inventory.detail(objectId),
    queryFn: objectId
      ? ({ signal }) => getInventoryObject({ objectId, signal })
      : skipToken,
  });
}

export function activityQueryOptions(
  search: string,
  status: string,
  walletId?: string,
  cursor?: string,
) {
  return queryOptions({
    queryKey: queryKeys.activity.page({ search, status, walletId, cursor }),
    queryFn: walletId
      ? ({ signal }) =>
          listActivityPage({ search, status, walletId, cursor, signal })
      : skipToken,
  });
}

// A ticket's status is read fresh: never kept past a reload or reopen, and a
// failed read is retried by the user, not silently.
const TICKETS_STALE_MS = 15_000;

export function ticketsQueryOptions(input: {
  slug: string;
  launchId: string;
  walletId?: string;
}) {
  const { slug, launchId, walletId } = input;
  // The launch id only scopes this tab's BFF reads; it does not change the
  // result, so it stays out of the key.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return infiniteQueryOptions({
    queryKey: queryKeys.tickets.list({ slug, walletId: walletId ?? "" }),
    initialPageParam: undefined as string | undefined,
    queryFn: walletId
      ? ({ pageParam, signal }) =>
          listTicketsPage({ slug, launchId, cursor: pageParam, signal })
      : skipToken,
    getNextPageParam: (page) => page.next ?? undefined,
    staleTime: TICKETS_STALE_MS,
    retry: false,
  });
}

export function ticketQueryOptions(input: {
  slug: string;
  launchId: string;
  walletId?: string;
  objectId: string;
}) {
  const { slug, launchId, walletId, objectId } = input;
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    queryKey: queryKeys.tickets.detail({
      slug,
      walletId: walletId ?? "",
      objectId,
    }),
    queryFn: walletId
      ? ({ signal }) => getTicket({ slug, launchId, objectId, signal })
      : skipToken,
    staleTime: TICKETS_STALE_MS,
    retry: false,
  });
}

export function productFaceContextQueryOptions(
  slug: string,
  launchId: string,
  enabled: boolean,
  /** The task the launch opened on; the register task may take a handover. */
  task = "/",
) {
  // The task is the launch's opening task only: the context is read once per
  // launch, never again when the face moves to another task.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    queryKey: queryKeys.productFaces.context(slug, launchId),
    queryFn: enabled
      ? () => loadProductFaceContext({ slug, launchId }, task)
      : skipToken,
    // A context load resets the launch's server-side selection, so it is
    // read once per launch (frame) and never refetched underneath a live face.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });
}

// Loyalty reads are proven afresh by the BFF on every read; a failed read is
// retried by the member, not silently.
const LOYALTY_STALE_MS = 15_000;

export function loyaltyProgrammeQueryOptions(input: {
  slug: string;
  launchId: string;
  walletId?: string;
}) {
  const { slug, launchId, walletId } = input;
  // The launch id only scopes this tab's BFF reads; it stays out of the key.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    queryKey: queryKeys.loyalty.programme({ slug, walletId: walletId ?? "" }),
    queryFn: walletId
      ? ({ signal }) => readProgramme({ slug, launchId }, signal)
      : skipToken,
    staleTime: LOYALTY_STALE_MS,
    retry: false,
  });
}

export function loyaltyMembershipQueryOptions(input: {
  slug: string;
  launchId: string;
  walletId?: string;
}) {
  const { slug, launchId, walletId } = input;
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    queryKey: queryKeys.loyalty.membership({ slug, walletId: walletId ?? "" }),
    queryFn: walletId
      ? ({ signal }) => readMembership({ slug, launchId }, signal)
      : skipToken,
    staleTime: LOYALTY_STALE_MS,
    retry: false,
  });
}

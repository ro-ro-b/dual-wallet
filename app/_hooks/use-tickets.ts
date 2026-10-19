"use client";

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { queryKeys } from "@/app/_hooks/query-keys";
import {
  ticketQueryOptions,
  ticketsQueryOptions,
} from "@/app/_hooks/query-options";

export function useTickets(input: {
  slug: string;
  launchId: string;
  walletId?: string;
}) {
  return useInfiniteQuery(ticketsQueryOptions(input));
}

export function useTicket(input: {
  slug: string;
  launchId: string;
  walletId?: string;
  objectId: string;
}) {
  return useQuery(ticketQueryOptions(input));
}

/**
 * Marks exactly one ticket's reads stale (its detail, and the programme's list
 * that the Tickets page and the home share) after something may have written
 * to it, so every surface reads Dual again rather than keep an earlier status.
 */
export function useRefreshTicket(input: {
  slug: string;
  walletId?: string;
  objectId: string;
}) {
  const client = useQueryClient();
  const { slug, objectId } = input;
  const walletId = input.walletId ?? "";
  return () =>
    Promise.all([
      client.invalidateQueries({
        queryKey: queryKeys.tickets.detail({ slug, walletId, objectId }),
        exact: true,
      }),
      client.invalidateQueries({
        queryKey: queryKeys.tickets.list({ slug, walletId }),
        exact: true,
      }),
    ]);
}

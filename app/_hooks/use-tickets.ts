"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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

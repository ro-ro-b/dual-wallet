"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/app/_hooks/query-keys";
import {
  loyaltyMembershipQueryOptions,
  loyaltyProgrammeQueryOptions,
} from "@/app/_hooks/query-options";

type Input = { slug: string; launchId: string; walletId?: string };

export function useLoyaltyProgramme(input: Input) {
  return useQuery(loyaltyProgrammeQueryOptions(input));
}

export function useLoyaltyMembership(input: Input) {
  return useQuery(loyaltyMembershipQueryOptions(input));
}

/**
 * Marks exactly this programme's membership read stale (the page and the
 * home share it) after a join or a submission, so both read it again.
 */
export function useRefreshMembership(input: {
  slug: string;
  walletId?: string;
}) {
  const client = useQueryClient();
  const { slug } = input;
  const walletId = input.walletId ?? "";
  return () =>
    client.invalidateQueries({
      queryKey: queryKeys.loyalty.membership({ slug, walletId }),
      exact: true,
    });
}

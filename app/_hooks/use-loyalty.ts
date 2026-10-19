"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/app/_hooks/query-keys";
import {
  loyaltyBenefitsQueryOptions,
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

export function useLoyaltyBenefits(input: Input & { enabled: boolean }) {
  return useQuery(loyaltyBenefitsQueryOptions(input));
}

/**
 * Marks exactly this programme's membership and benefits reads stale (the
 * page and the home share them) after a join, a submission or a request, so
 * both read them again.
 */
export function useRefreshMembership(input: {
  slug: string;
  walletId?: string;
}) {
  const client = useQueryClient();
  const { slug } = input;
  const walletId = input.walletId ?? "";
  return () =>
    Promise.all([
      client.invalidateQueries({
        queryKey: queryKeys.loyalty.membership({ slug, walletId }),
        exact: true,
      }),
      client.invalidateQueries({
        queryKey: queryKeys.loyalty.benefits({ slug, walletId }),
        exact: true,
      }),
    ]);
}

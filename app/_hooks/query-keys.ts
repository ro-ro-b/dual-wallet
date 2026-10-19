export const queryKeys = {
  session: {
    all: ["viewer-session"] as const,
  },
  inventory: {
    all: ["inventory"] as const,
    lists: () => ["inventory", "list"] as const,
    list: (input: { search: string; owner?: string }) =>
      ["inventory", "list", input] as const,
    details: () => ["inventory", "detail"] as const,
    detail: (objectId: string) =>
      ["inventory", "detail", { objectId }] as const,
  },
  productFaces: {
    all: ["product-faces"] as const,
    // The binding does not depend on the wallet. Keeping the wallet out of the
    // key means an account change cannot silently swap the frame; the host
    // ends the old channel first and the user reopens it.
    context: (slug: string, launchId: string) =>
      ["product-faces", "context", { slug, launchId }] as const,
  },
  // Tickets are the current holder's own: every key names the wallet, the
  // programme and (for a list) the cursor, so an account change reads nothing
  // of the previous one.
  tickets: {
    all: ["tickets"] as const,
    list: (input: { slug: string; walletId: string }) =>
      ["tickets", "list", input] as const,
    detail: (input: { slug: string; walletId: string; objectId: string }) =>
      ["tickets", "detail", input] as const,
  },
  // Loyalty is the current holder's own: every key names the wallet and the
  // programme, so an account change reads nothing of the previous one.
  loyalty: {
    all: ["loyalty"] as const,
    programme: (input: { slug: string; walletId: string }) =>
      ["loyalty", "programme", input] as const,
    membership: (input: { slug: string; walletId: string }) =>
      ["loyalty", "membership", input] as const,
  },
  activity: {
    all: ["activity"] as const,
    page: (input: {
      search: string;
      status: string;
      walletId?: string;
      cursor?: string;
    }) => ["activity", "page", input] as const,
  },
} as const;

import { MemWal } from "@mysten-incubation/memwal";

export const NAMESPACE = {
  owned: "hippo",
  guest: (personId: string) => `hippo-guest:${personId}`,
} as const;

/** Everything needed to talk to one (account, namespace) through the relayer. */
export interface MemoryScope {
  mode: "guest" | "owned";
  key: string;
  accountId: string;
  namespace: string;
  serverUrl: string;
}

export function guestScope(
  operator: { key: string; accountId: string; serverUrl: string },
  personId: string,
): MemoryScope {
  return { mode: "guest", ...operator, namespace: NAMESPACE.guest(personId) };
}

export function ownedScope(user: {
  key: string;
  accountId: string;
  serverUrl: string;
}): MemoryScope {
  return { mode: "owned", ...user, namespace: NAMESPACE.owned };
}

export function createClient(scope: MemoryScope): MemWal {
  return MemWal.create({
    key: scope.key,
    accountId: scope.accountId,
    serverUrl: scope.serverUrl,
    namespace: scope.namespace,
  });
}

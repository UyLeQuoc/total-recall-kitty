/**
 * Wallets on Sui testnet (ADR-0064). The browser talks gRPC-web to the public testnet fullnode
 * (ADR-0021); everything else goes through Kitty's API. Same setup as Remora's web
 * (apps/web/src/app/providers.tsx), testnet only.
 */
import { createNetworkConfig, SuiClientProvider, WalletProvider } from "@mysten/dapp-kit";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";

const { networkConfig } = createNetworkConfig({
  testnet: { url: "https://fullnode.testnet.sui.io:443", network: "testnet" },
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true } },
});

type CreateClient = NonNullable<ComponentProps<typeof SuiClientProvider>["createClient"]>;

function createClient(_name: string, cfg: { url: string }): ReturnType<CreateClient> {
  const client = new SuiGrpcClient({ network: "testnet", baseUrl: cfg.url });
  // dapp-kit still types this callback as a JSON-RPC client. Public fullnodes retired that transport.
  return client as unknown as ReturnType<CreateClient>;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider
        networks={networkConfig}
        defaultNetwork="testnet"
        createClient={createClient}
      >
        <WalletProvider autoConnect>{children}</WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}

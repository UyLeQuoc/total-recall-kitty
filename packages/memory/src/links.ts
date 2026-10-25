/** Explorer links judges and users will click. */
export const explorer = {
  object: (id: string) => `https://suiscan.xyz/mainnet/object/${id}`,
  address: (addr: string) => `https://suiscan.xyz/mainnet/account/${addr}`,
  tx: (digest: string) => `https://suiscan.xyz/mainnet/tx/${digest}`,
  /** Walrus blob, via the public mainnet aggregator. */
  blob: (blobId: string) => `https://aggregator.walrus-mainnet.walrus.space/v1/blobs/${blobId}`,
  blobExplorer: (blobId: string) => `https://walruscan.com/mainnet/blob/${blobId}`,
} as const;

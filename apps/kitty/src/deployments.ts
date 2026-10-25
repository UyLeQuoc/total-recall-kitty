/** Written by scripts/publish.ts (KT1, ADR-0062). Testnet only; mainnet is Uy's call (ADR-0024). */
export const DEPLOYMENTS = {
  testnet: {
    packageId: "0xcd3889825bd9c444b4ef1b9846d84777784292546e83bec3c883ae89ff30d056",
    upgradeCapId: "0xe1abca059baa4954993dbd57ce1fafa74a2d2b4257cb26572bc2302a2435d3aa",
    publishDigest: "CC51MbvM1aM5MY6hqo3sqFw4kNTQpqegpCnc7DmkWvhJ",
  },
} as const;

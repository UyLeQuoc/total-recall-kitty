/**
 * Written by scripts/publish.ts (KT1, ADR-0062) and scripts/upgrade.ts (KT4, ADR-0067). Testnet only;
 * mainnet is Uy's call (ADR-0024). Calls target `packageId`; types (`Pot<C>`, `KITTY`) keep
 * `originalPackageId`.
 */
export const DEPLOYMENTS = {
  testnet: {
    packageId: "0x0440fb4b853512775c229ad0b991c5242c4e6320a7a0cc41387362d76d7bdd88",
    originalPackageId: "0xcd3889825bd9c444b4ef1b9846d84777784292546e83bec3c883ae89ff30d056",
    version: 2,
    upgradeCapId: "0xe1abca059baa4954993dbd57ce1fafa74a2d2b4257cb26572bc2302a2435d3aa",
    publishDigest: "CC51MbvM1aM5MY6hqo3sqFw4kNTQpqegpCnc7DmkWvhJ",
    upgradeDigest: "mKv4cTNdhdBWTxD9aKLcLek84qiQyXWa98FDQN3zxi4",
  },
} as const;

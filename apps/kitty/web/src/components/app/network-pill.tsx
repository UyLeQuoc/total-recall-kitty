/**
 * The network, where Remora's top bar puts its network control (ADR-0066). Kitty runs on testnet only,
 * so it's a label, not a menu.
 */
export function NetworkPill() {
  return (
    <span
      title="Sui testnet: test USDC only. Kitty pays the gas."
      className="inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground"
    >
      <span aria-hidden className="size-2 rounded-full bg-warning" />
      Testnet
    </span>
  );
}

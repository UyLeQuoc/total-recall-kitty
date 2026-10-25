// Copied from Remora: apps/web/src/app/wallet-avatar.tsx (ADR-0066).
function hash(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < 8; i++) {
    h = Math.imul(h ^ (h >>> 13), 16777619);
    out.push(h >>> 0);
  }
  return out;
}

export function walletAvatarSvg(seed: string): string {
  const bits = hash(seed);
  const hue = (bits[0] ?? 0) % 360;
  const ink = `hsl(${hue} 62% 42%)`;
  const paper = `hsl(${hue} 35% 93%)`;
  const cells: string[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (((bits[1 + y] ?? 0) >> x) & 1) {
        cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${ink}"/>`);
        if (x !== 2) {
          cells.push(`<rect x="${4 - x}" y="${y}" width="1" height="1" fill="${ink}"/>`);
        }
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" shape-rendering="crispEdges"><rect width="5" height="5" fill="${paper}"/>${cells.join("")}</svg>`;
}

export function WalletAvatar({ address }: { address: string }) {
  const svg = walletAvatarSvg(address);
  return (
    <img
      alt=""
      width={32}
      height={32}
      className="size-8 shrink-0 rounded-full"
      src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
    />
  );
}

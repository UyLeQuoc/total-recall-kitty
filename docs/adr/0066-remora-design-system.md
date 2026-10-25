# ADR-0066: Kitty's web uses Remora's design system

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Uy

## Context
Kitty's wallet web ([ADR-0064](0064-receipts-kitty-web-with-wallets.md)) was built overnight with its
own look:
- an orange palette;
- hand-written stone and emerald classes;
- a centred column;
- dapp-kit's connect button.

On Oct 25 Uy asked for both apps to follow Remora's style ("dựa theo style remora, update UI cho 2 app
kia luôn"). Remora's web has a settled design system, Huấn's work, recorded in Remora's ADR-0036
(UI foundation) and ADR-0039 (electric indigo).

## Decision
- **Tokens:** copy Remora's `:root`, `.dark` and `@theme inline` blocks from `apps/web/src/index.css`:
  - warm neutrals;
  - one electric-indigo primary for both themes;
  - semantic success and warning colours.

  Colours are tokens only; no palette class or hex outside `components/ui`.
- **Kit:** copy the shadcn new-york components Kitty uses from Remora's `apps/web/src/components/ui`
  into `web/src/components/ui`, each with a comment naming its source. Like Remora, Biome skips that
  folder.
  - Page components follow the same pattern: `Page`, `PageHeader`, `Section`, `StatTile`,
    `EmptyState`, `ConfirmAction`.
  - New dependencies are pinned to Remora's locked versions: `radix-ui` 1.6.7, `lucide-react` 0.577.0,
    `class-variance-authority` 0.7.1, `cn` 0.4.0 and `tw-animate-css` 1.4.0.
- **Shell:** Remora's layout.
  - An inset sidebar holds the logo, the links, the pot you're on, your pots, and the wallet in the
    footer. On a phone it becomes a sheet.
  - A rounded content panel has a top bar with the sidebar toggle, the page title on a phone, and a
    "Testnet" pill.
  - The theme can be light, dark or follow the system. It is decided before the first paint, as
    Remora does.
- **Logo:** in the shape of Remora's: one `currentColor` path (a cat's head) on a rounded indigo tile,
  with the lowercase word "kitty".
- **Wallets:** a "Connect wallet" dialog like Remora's wallet picker replaces dapp-kit's button. Leaving
  a pot goes through Remora's confirm dialog.
- **Behaviour is unchanged:** the API, the sponsored wallet flow (ADR-0064) and the e2e's steps stay
  the same. The e2e only matches "Connect wallet" exactly.

## Consequences
- Kitty and Remora now look like one family. A component fixed in Remora is ported by hand, as with
  `chain` and `memory` (ADR-0065).
- The bundle grows by about 70 kB gzipped, for Radix and the icons.
- The page scrolls inside the panel, like Remora's, so a full-page screenshot captures only the viewport.
  `e2e/screens.e2e.ts` takes Home and a pot page in light and dark, at 1280 and 375 px, and spends
  nothing.

## Links
- [ADR-0064](0064-receipts-kitty-web-with-wallets.md), [ADR-0065](0065-split-receipts-and-kitty-repos.md)
- Remora: `apps/web/src/index.css`, `apps/web/src/components/ui`, `apps/web/src/components/app`,
  `apps/web/src/app/app-layout.tsx`, its ADR-0036 and ADR-0039

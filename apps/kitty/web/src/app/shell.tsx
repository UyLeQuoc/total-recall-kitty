/** The page title the top bar shows on a phone (after Remora's apps/web/src/app/shell.tsx, ADR-0066). */
import { createContext, useContext, useEffect } from "react";

export const ShellContext = createContext<{ setTitle: (title: string) => void } | null>(null);

export function useShellTitle(title: string) {
  const shell = useContext(ShellContext);
  useEffect(() => {
    shell?.setTitle(title);
  }, [shell, title]);
}

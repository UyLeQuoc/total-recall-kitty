/** Small building blocks shared by the pages. */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import type { Memory, Step } from "../api.ts";
import { stepLabel } from "../api.ts";
import { blobUrl, pretty, txUrl } from "../format.ts";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Card({
  children,
  className,
  tone = "plain",
}: {
  children: ReactNode;
  className?: string;
  tone?: "plain" | "brand" | "muted";
}) {
  return (
    <section
      className={cx(
        "rounded-2xl border p-4 sm:p-5",
        tone === "plain" &&
          "border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900",
        tone === "brand" && "border-brand-200 bg-brand-50 dark:border-brand-900 dark:bg-stone-900",
        tone === "muted" &&
          "border-stone-200 bg-stone-100/60 dark:border-stone-800 dark:bg-stone-900/60",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function Badge({
  children,
  tone = "plain",
}: {
  children: ReactNode;
  tone?: "plain" | "good" | "bad" | "brand" | "test";
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        tone === "plain" && "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300",
        tone === "good" &&
          "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
        tone === "bad" && "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300",
        tone === "brand" && "bg-brand-100 text-brand-800 dark:bg-brand-900/50 dark:text-brand-200",
        tone === "test" && "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300",
      )}
    >
      {children}
    </span>
  );
}

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" &&
          "bg-brand-600 text-white shadow-sm hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
        variant === "ghost" &&
          "border border-stone-300 bg-white text-stone-800 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800",
        variant === "danger" &&
          "border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:bg-stone-900 dark:text-rose-300",
        className,
      )}
    />
  );
}

export function Field({
  label,
  hint,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className={cx("flex flex-col gap-1 text-sm", className)}>
      <span className="font-medium text-stone-700 dark:text-stone-300">{label}</span>
      <input
        {...props}
        className="min-h-10 rounded-xl border border-stone-300 bg-white px-3 py-2 text-base text-stone-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200 sm:text-sm dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:ring-brand-900"
      />
      {hint ? <span className="text-xs text-stone-500">{hint}</span> : null}
    </label>
  );
}

export function Progress({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-3 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** A 🧠 reason: the memory's text, linking the Walrus blob behind it. */
export function MemoryChip({ memory, label }: { memory: Memory; label?: string }) {
  return (
    <div className="mt-2 rounded-xl bg-brand-50 px-3 py-2 text-sm text-stone-700 dark:bg-stone-800 dark:text-stone-200">
      <span aria-hidden>🧠 </span>
      {label ? <span className="font-medium">{label} </span> : null}
      <span className="break-words">{memory.text ? pretty(memory.text) : "(being stored…)"}</span>
      {memory.blobId ? (
        <a
          className="ml-1 whitespace-nowrap text-xs font-medium text-brand-700 underline decoration-dotted underline-offset-2 dark:text-brand-300"
          href={blobUrl(memory.blobId)}
          target="_blank"
          rel="noreferrer"
        >
          blob {memory.blobId.slice(0, 8)}…
        </a>
      ) : (
        <span className="ml-1 text-xs text-stone-500">storing on Walrus…</span>
      )}
    </div>
  );
}

export function TxLink({ digest, label = "tx" }: { digest: string; label?: string }) {
  return (
    <a
      className="whitespace-nowrap text-xs font-medium text-brand-700 underline decoration-dotted underline-offset-2 dark:text-brand-300"
      href={txUrl(digest)}
      target="_blank"
      rel="noreferrer"
    >
      {label} ↗
    </a>
  );
}

/** Where the wallet flow is, or what went wrong. */
export function Status({ step, error }: { step: Step; error: string | null }) {
  if (step !== "idle")
    return (
      <p
        className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-300"
        role="status"
      >
        <span className="size-3 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
        {stepLabel[step]}
      </p>
    );
  if (error)
    return (
      <p
        className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950/50 dark:text-rose-200"
        role="alert"
      >
        {error}
      </p>
    );
  return null;
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-stone-100 px-3 py-2 dark:bg-stone-800/70">
      <div className="text-xs text-stone-500 dark:text-stone-400">{label}</div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}

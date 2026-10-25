/**
 * Kitty's own pieces, built from Remora's kit (ADR-0066): a labelled field, the 🧠 reason that links its
 * Walrus blob, a transaction link, and where the wallet flow is.
 */
import { ArrowUpRight, Brain } from "lucide-react";
import { type ComponentProps, type ReactNode, useId } from "react";
import { type Memory, type Step, stepLabel } from "@/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { blobUrl, pretty, txUrl } from "@/format";
import { cn } from "@/lib/utils";

export function Field({
  label,
  hint,
  className,
  ...props
}: ComponentProps<typeof Input> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...props} />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function SelectField({
  label,
  className,
  children,
  ...props
}: ComponentProps<typeof NativeSelect> & { label: string }) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} {...props}>
        {children}
      </NativeSelect>
    </div>
  );
}

/** A 🧠 reason: the memory's text, linking the Walrus blob behind it. */
export function MemoryChip({ memory, label }: { memory: Memory; label?: string }) {
  return (
    <div className="flex gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">
      <Brain aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
      <p className="min-w-0 break-words">
        {label ? <span className="font-medium">{label} </span> : null}
        {memory.text ? pretty(memory.text) : "(being stored…)"}{" "}
        {memory.blobId ? (
          <a
            className="whitespace-nowrap font-medium text-primary underline-offset-4 hover:underline"
            href={blobUrl(memory.blobId)}
            target="_blank"
            rel="noreferrer"
          >
            blob {memory.blobId.slice(0, 8)}…
          </a>
        ) : (
          <span className="text-muted-foreground">storing on Walrus…</span>
        )}
      </p>
    </div>
  );
}

export function TxLink({ digest, label = "tx" }: { digest: string; label?: string }) {
  return (
    <a
      className="inline-flex items-center gap-0.5 text-sm font-medium whitespace-nowrap text-primary underline-offset-4 hover:underline"
      href={txUrl(digest)}
      target="_blank"
      rel="noreferrer"
    >
      {label}
      <ArrowUpRight aria-hidden className="size-3.5" />
    </a>
  );
}

/** Where the wallet flow is, or what went wrong. */
export function TxStatus({ step, error }: { step: Step; error: string | null }) {
  if (step !== "idle")
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner className="text-primary" />
        {stepLabel[step]}
      </p>
    );
  if (error)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  return null;
}

/** A confirmation after a transaction, with its link. */
export function Done({ digest, children }: { digest: string; children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-1 text-sm text-success-foreground">
      {children} <TxLink digest={digest} />
    </p>
  );
}

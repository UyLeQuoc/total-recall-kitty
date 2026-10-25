/** "What Kitty learned": every memory behind a pot's reasons, each linking its Walrus blob. */
import { Link, useParams } from "react-router";
import { useMemories, usePot } from "../api.ts";
import { Badge, Card } from "../components/ui.tsx";
import { blobUrl, pretty, when } from "../format.ts";

const KINDS: Record<string, string> = {
  members: "members",
  norms: "how the group decides",
};

export function Learned() {
  const { id = "" } = useParams();
  const pot = usePot(id);
  const rows = useMemories(id);
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <Link to={`/pots/${id}`} className="text-sm text-stone-500 hover:text-stone-800">
          ← {pot.data?.pot.name ?? "The pot"}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">What Kitty learned</h1>
        <p className="text-stone-600 dark:text-stone-400">
          Every reason Kitty gives is a Walrus Memory (mainnet): paydays, skips, how the group
          approves, the rules it voted. Kitty reads them back before it acts.
        </p>
      </div>
      {rows.isLoading ? <p className="text-sm text-stone-500">Loading…</p> : null}
      {rows.data?.length === 0 ? (
        <p className="text-sm text-stone-500">Nothing yet. Kitty learns once members join.</p>
      ) : null}
      <div className="grid gap-2">
        {rows.data?.map((r) => {
          const kind = r.namespace.split(":").at(-1) ?? "";
          return (
            <Card key={r.id} className="!p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge tone={kind === "norms" ? "brand" : "plain"}>{KINDS[kind] ?? kind}</Badge>
                <span className="text-xs text-stone-500">{when(r.createdAt)}</span>
              </div>
              <p className="mt-2 font-mono text-[13px] leading-relaxed break-words" title={r.text}>
                {r.text ? pretty(r.text) : "(text pending)"}
              </p>
              <p className="mt-1 text-xs text-stone-500">
                {r.blobId ? (
                  <a
                    className="font-medium text-brand-700 underline decoration-dotted dark:text-brand-300"
                    href={blobUrl(r.blobId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    blob {r.blobId}
                  </a>
                ) : (
                  `status ${r.status}`
                )}
              </p>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

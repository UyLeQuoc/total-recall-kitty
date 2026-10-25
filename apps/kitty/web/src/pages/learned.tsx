/** "What Kitty learned": every memory behind a pot's reasons, each linking its Walrus blob. */
import { ArrowLeft, ArrowUpRight, Brain } from "lucide-react";
import { Link, useParams } from "react-router";
import { useMemories, usePot } from "@/api";
import { EmptyState } from "@/components/app/empty-state";
import { Page, PageHeader } from "@/components/app/page";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { blobUrl, pretty, when } from "@/format";

const KINDS: Record<string, string> = {
  members: "members",
  norms: "how the group decides",
};

export function Learned() {
  const { id = "" } = useParams();
  const pot = usePot(id);
  const rows = useMemories(id);
  return (
    <Page title="What Kitty learned">
      <div className="flex flex-col gap-3">
        <Link
          to={`/pots/${id}`}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-4" />
          {pot.data?.pot.name ?? "The pot"}
        </Link>
        <PageHeader
          title="What Kitty learned"
          description="Every reason Kitty gives is a Walrus Memory (mainnet): paydays, skips, how the group approves, the rules it voted. Kitty reads them back before it acts."
        />
      </div>
      {rows.isLoading ? (
        <div className="grid gap-3">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : null}
      {rows.data?.length === 0 ? (
        <EmptyState
          icon={<Brain />}
          title="Nothing yet"
          description="Kitty learns once members join: paydays, skips and how the group approves."
        />
      ) : null}
      <div className="grid gap-3">
        {rows.data?.map((r) => {
          const kind = r.namespace.split(":").at(-1) ?? "";
          return (
            <Card key={r.id} className="gap-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge variant={kind === "norms" ? "accent" : "secondary"}>
                  {KINDS[kind] ?? kind}
                </Badge>
                <span className="text-sm text-muted-foreground">{when(r.createdAt)}</span>
              </div>
              <p className="font-mono text-sm leading-relaxed break-words" title={r.text}>
                {r.text ? pretty(r.text) : "(text pending)"}
              </p>
              <p className="text-sm text-muted-foreground">
                {r.blobId ? (
                  <a
                    className="inline-flex max-w-full items-center gap-0.5 font-medium text-primary underline-offset-4 hover:underline"
                    href={blobUrl(r.blobId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="truncate">blob {r.blobId}</span>
                    <ArrowUpRight aria-hidden className="size-3.5 shrink-0" />
                  </a>
                ) : (
                  `status ${r.status}`
                )}
              </p>
            </Card>
          );
        })}
      </div>
    </Page>
  );
}

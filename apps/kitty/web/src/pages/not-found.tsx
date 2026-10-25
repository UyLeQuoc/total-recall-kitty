import { Compass } from "lucide-react";
import { Link } from "react-router";
import { EmptyState } from "@/components/app/empty-state";
import { Page } from "@/components/app/page";
import { Button } from "@/components/ui/button";

export function NotFound() {
  return (
    <Page title="Not found">
      <EmptyState
        icon={<Compass />}
        title="Nothing here"
        description="This page doesn't exist on Kitty."
        action={
          <Button asChild variant="outline">
            <Link to="/">Back to the pots</Link>
          </Button>
        }
      />
    </Page>
  );
}

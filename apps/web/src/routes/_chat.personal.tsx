import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { usePersonalAgent } from "../hooks/usePersonalAgent";

// A stable address for the personal agent: opens (creating it the first time)
// the environment's one long-running personal thread.
function PersonalAgentRoute() {
  const { connected, openPersonalAgent } = usePersonalAgent();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!connected || started.current) return;
    started.current = true;
    void openPersonalAgent({ replace: true }).then(setError);
  }, [connected, openPersonalAgent]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          {error === null ? (
            <>
              <Spinner />
              <EmptyTitle>Opening your personal agent</EmptyTitle>
            </>
          ) : (
            <>
              <EmptyTitle>Could not open the personal agent</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
              <Button
                variant="outline"
                onClick={() => {
                  setError(null);
                  void openPersonalAgent({ replace: true }).then(setError);
                }}
              >
                Try again
              </Button>
            </>
          )}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/personal")({
  component: PersonalAgentRoute,
});

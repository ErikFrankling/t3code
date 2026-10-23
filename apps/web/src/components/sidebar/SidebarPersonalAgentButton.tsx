import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { PERSONAL_AGENT_THREAD_ID, todoSection } from "@t3tools/contracts";
import { SparklesIcon } from "lucide-react";
import { memo } from "react";

import { usePersonalAgent } from "../../hooks/usePersonalAgent";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import {
  hasUnseenSpoken,
  usePersonalAgentHome,
  useSpokenSeenAt,
} from "../personalAgent/PersonalAgentHome";
import { useSidebar } from "../ui/sidebar";

/**
 * The personal agent is not a thread in the list: it has its own button at the
 * top of the sidebar, with how many items need the user, and a dot while it
 * works or when it said something new out loud.
 */
export const SidebarPersonalAgentButton = memo(function SidebarPersonalAgentButton() {
  const { environmentId, openPersonalAgent, isPersonalAgentOpen } = usePersonalAgent();
  const { isMobile, setOpenMobile } = useSidebar();
  const { state } = usePersonalAgentHome(environmentId);
  const shell = useThreadShell(
    environmentId === null ? null : scopeThreadRef(environmentId, PERSONAL_AGENT_THREAD_ID),
  );
  const seenAt = useSpokenSeenAt();
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const needsYou = (state?.items ?? []).filter(
    (item) => todoSection(item, now) === "needs_you",
  ).length;
  const working = shell !== null && isThreadWorking(shell);
  const spokeNew = hasUnseenSpoken(state?.spoken ?? [], seenAt);
  const status = working ? "Working" : spokeNew ? "Said something new" : null;

  return (
    <button
      type="button"
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        void openPersonalAgent();
      }}
      aria-current={isPersonalAgentOpen ? "page" : undefined}
      aria-label={["Personal agent", needsYou > 0 ? `${needsYou} need you` : null, status]
        .filter((part) => part !== null)
        .join(", ")}
      className={cn(
        "mb-1 flex h-10 w-full items-center gap-2.5 rounded-lg border px-2.5 text-left text-sm font-medium transition-colors",
        isPersonalAgentOpen
          ? "border-primary/40 bg-primary/10 text-sidebar-foreground"
          : "border-sidebar-border bg-sidebar-row-hover/40 text-sidebar-foreground hover:bg-sidebar-row-hover",
      )}
    >
      <span className="relative flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        <SparklesIcon className="size-3.5" />
        {status !== null ? (
          <span
            aria-hidden
            className={cn(
              "absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar",
              working ? "animate-pulse bg-info" : "bg-primary",
            )}
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1 truncate">Personal agent</span>
      {needsYou > 0 ? (
        <span className="rounded-full bg-warning/18 px-1.5 py-px text-2xs font-semibold tabular-nums text-warning-foreground">
          {needsYou}
        </span>
      ) : null}
    </button>
  );
});

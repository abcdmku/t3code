import type { T3ProjectFileSurface } from "@t3tools/contracts";

import { surfaceEntryKey } from "~/lib/surfaceUrls";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@t3tools/ui/tooltip";

import { SurfaceEntryIcon } from "./SurfaceEntryIcon";
import { PROJECT_SURFACE_DISABLED_REASON } from "./surfacePresentation";

export function SidebarProjectSurfaces({
  surfaces,
  browserAvailable,
  onOpenSurface,
  className,
}: {
  surfaces: ReadonlyArray<T3ProjectFileSurface>;
  browserAvailable: boolean;
  onOpenSurface: (surface: T3ProjectFileSurface) => void;
  className?: string;
}) {
  if (surfaces.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-px", className)}>
      {surfaces.map((surface, index) => {
        const button = (
          <button
            type="button"
            aria-label={`Open custom project surface ${surface.name}`}
            aria-disabled={!browserAvailable}
            className={cn(
              "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-sidebar-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              browserAvailable
                ? "cursor-pointer hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                : "cursor-not-allowed opacity-40",
            )}
            onClick={() => {
              if (browserAvailable) onOpenSurface(surface);
            }}
          >
            <SurfaceEntryIcon icon={surface.icon} className="size-3.5 shrink-0" />
            <span className="truncate">{surface.name}</span>
          </button>
        );

        if (browserAvailable) {
          return (
            <span key={surfaceEntryKey(surface, index)} className="contents">
              {button}
            </span>
          );
        }
        return (
          <Tooltip key={surfaceEntryKey(surface, index)}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="right">{PROJECT_SURFACE_DISABLED_REASON}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

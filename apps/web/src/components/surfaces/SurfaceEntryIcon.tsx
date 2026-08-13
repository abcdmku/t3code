import {
  AppWindowIcon,
  BugIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  WrenchIcon,
} from "lucide-react";

export function SurfaceEntryIcon({
  icon,
  className = "size-3.5",
}: {
  icon?: string | undefined;
  className?: string;
}) {
  if (icon === "play") return <PlayIcon className={className} />;
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <AppWindowIcon className={className} />;
}

import { Button } from "@heroui/react";
import { ArrowLeft } from "lucide-react";

/**
 * The way back at the top of a screen, named after where it leads. One look everywhere: its
 * arrow hangs into the margin so the label lines up with the title under it, and a long name is
 * cut off rather than wrapped.
 */
export function BackLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="-ml-3 max-w-full self-start text-muted" onPress={onPress}>
      <ArrowLeft aria-hidden />
      <span className="truncate">{label}</span>
    </Button>
  );
}

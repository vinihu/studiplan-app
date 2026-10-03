import { Button, Tooltip } from "@heroui/react";
import type { ComponentProps, ReactNode } from "react";

/**
 * A button that shows only an icon. Every one in the app is this: the same size as the small
 * buttons next to it, a name for screen readers, and a tooltip that says what it does after the
 * pointer has rested on it.
 */
export function IconButton({
  label,
  tooltip,
  children,
  size = "sm",
  ...props
}: Omit<ComponentProps<typeof Button>, "isIconOnly" | "variant" | "aria-label" | "children"> & {
  /** The accessible name. It says which thing the button acts on: `Remove chapter-3.pdf`. */
  label: string;
  /** What the pointer is told: the action alone, since it is next to the thing. */
  tooltip: ReactNode;
  children: ReactNode;
}) {
  return (
    <Tooltip delay={500}>
      <Button isIconOnly variant="ghost" size={size} aria-label={label} {...props}>
        {children}
      </Button>
      <Tooltip.Content>{tooltip}</Tooltip.Content>
    </Tooltip>
  );
}

import { Alert, CloseButton } from "@heroui/react";
import type { ReactNode, Ref } from "react";

/**
 * A message on a screen: something that happened, went wrong, or should be known. Every one has
 * the same build: the sign, a title, what there is to say under it, then its one action, then
 * the button that puts it away. All of them sit on the title's line, so a short notice and a
 * long one have their buttons in the same place.
 */
export function Notice({
  status = "default",
  role,
  title,
  children,
  action,
  onClose,
  closeRef,
  className = "",
  testId,
}: {
  /** `danger` for something that failed; everything else is `default`. */
  status?: "default" | "danger";
  /** `alert` interrupts a screen reader, `status` waits its turn. Left out for a standing note. */
  role?: "alert" | "status";
  title: ReactNode;
  /** A sentence (given as a string), or anything longer, laid out by the caller. */
  children?: ReactNode;
  /** The one thing to do about it: a small outline button. */
  action?: ReactNode;
  /** With this, the notice can be put away. */
  onClose?: () => void;
  closeRef?: Ref<HTMLButtonElement>;
  className?: string;
  testId?: string;
}) {
  return (
    <Alert status={status} className={className} data-testid={testId} {...(role ? { role } : {})}>
      <Alert.Indicator />
      <Alert.Content className="min-w-0 gap-1">
        <Alert.Title className="[overflow-wrap:anywhere]">{title}</Alert.Title>
        {typeof children === "string" ? (
          <Alert.Description className="[overflow-wrap:anywhere]">{children}</Alert.Description>
        ) : (
          children
        )}
      </Alert.Content>
      {/* A small button is taller than the title's line: pulled up so the two share a middle. */}
      {action ? <div className="-my-1 flex shrink-0 items-center gap-2">{action}</div> : null}
      {onClose ? <CloseButton ref={closeRef} aria-label="Close this message" onPress={onClose} /> : null}
    </Alert>
  );
}

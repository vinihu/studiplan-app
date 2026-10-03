import { AlertDialog, Button } from "@heroui/react";
import { useState } from "react";
import type { ReactNode } from "react";

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Names the thing: `Delete "Biology"?` */
  title: string;
  /** Says what is inside it and what happens to it. */
  children: ReactNode;
  /** Text of the red button: "Delete", "Remove". */
  confirmLabel: string;
  /** Does the work. Resolves to `null` when it worked, or to a sentence saying why it failed. */
  onConfirm: () => Promise<string | null>;
}

/**
 * Asks before something is deleted. Focus starts on Cancel, so a stray Enter never deletes;
 * Escape closes.
 */
export function ConfirmDialog({ isOpen, onClose, ...content }: ConfirmDialogProps) {
  return (
    <AlertDialog.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      isKeyboardDismissDisabled={false}
    >
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog>
          <ConfirmContent onClose={onClose} {...content} />
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function ConfirmContent({
  onClose,
  title,
  children,
  confirmLabel,
  onConfirm,
}: Omit<ConfirmDialogProps, "isOpen">) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const failure = await onConfirm();
    setPending(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  return (
    <>
      <AlertDialog.Header>
        <AlertDialog.Heading className="break-words">{title}</AlertDialog.Heading>
      </AlertDialog.Header>
      <AlertDialog.Body className="flex flex-col gap-3 text-sm text-muted">
        <div>{children}</div>
        {error ? (
          <p role="alert" className="font-medium text-danger">
            {error}
          </p>
        ) : null}
      </AlertDialog.Body>
      <AlertDialog.Footer>
        <Button autoFocus variant="outline" onPress={onClose} isDisabled={pending}>
          Cancel
        </Button>
        <Button variant="danger" onPress={() => void confirm()} isPending={pending}>
          {error ? "Try again" : confirmLabel}
        </Button>
      </AlertDialog.Footer>
    </>
  );
}

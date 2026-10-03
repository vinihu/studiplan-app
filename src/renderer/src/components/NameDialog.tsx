import { Button, FieldError, Form, Input, Label, Modal, TextField } from "@heroui/react";
import { useState } from "react";
import type { FormEvent } from "react";

export interface NameDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** "New subject", "Rename material", … */
  title: string;
  /** Label of the one field: "Name" or "Title". */
  label: string;
  /** Text of the confirming button: "Create", "Rename". */
  submitLabel: string;
  /** One line under the title saying what this thing is. Optional. */
  hint?: string;
  placeholder?: string;
  /** The current name when renaming. */
  initialValue?: string;
  /**
   * Does the work. Resolves to `null` when it worked (the dialog closes) or to a sentence saying
   * why the name was refused (shown under the field, the dialog stays open).
   */
  onSubmit: (name: string) => Promise<string | null>;
}

/**
 * The dialog that asks for one name: new subject, new material, and renaming either.
 * Enter submits, Escape closes.
 */
export function NameDialog({ isOpen, onClose, ...form }: NameDialogProps) {
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="sm">
        <Modal.Dialog>
          {/* Mounted only while open, so every opening starts from a clean field. */}
          <NameForm onClose={onClose} {...form} />
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function NameForm({
  onClose,
  title,
  label,
  submitLabel,
  hint,
  placeholder,
  initialValue = "",
  onSubmit,
}: Omit<NameDialogProps, "isOpen">) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const name = value.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (name === "") {
      // Spaces only: say so, rather than doing nothing when Enter is pressed.
      if (value !== "") setError(`Type a ${label.toLowerCase()} first. Spaces alone are not one.`);
      return;
    }
    if (name === initialValue) {
      onClose();
      return;
    }
    setPending(true);
    const refusal = await onSubmit(name);
    setPending(false);
    if (refusal === null) onClose();
    else setError(refusal);
  };

  return (
    <Form onSubmit={submit} className="flex flex-col">
      <Modal.Header>
        <Modal.Heading>{title}</Modal.Heading>
        {hint ? <p className="text-sm text-muted">{hint}</p> : null}
      </Modal.Header>
      <Modal.Body className="px-1 py-1">
        <TextField
          autoFocus
          fullWidth
          name="name"
          value={value}
          onChange={(next) => {
            setValue(next);
            setError(null);
          }}
          isInvalid={error !== null}
          // Read-only, not disabled, while saving: a disabled field would drop the focus, and
          // with it Escape and the chance to correct a refused name straight away.
          isReadOnly={pending}
        >
          <Label>{label}</Label>
          <Input {...(placeholder ? { placeholder } : {})} autoComplete="off" spellCheck="false" />
          <FieldError>{error}</FieldError>
        </TextField>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline" onPress={onClose} isDisabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" isDisabled={value === ""} isPending={pending}>
          {submitLabel}
        </Button>
      </Modal.Footer>
    </Form>
  );
}

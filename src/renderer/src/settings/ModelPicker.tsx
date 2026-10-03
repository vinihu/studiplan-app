import { Button, FieldError, Form, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { useState } from "react";
import type { FormEvent } from "react";
import { isModelId } from "@shared/providers";
import type { ProviderModel } from "@shared/providers";

/** The Select's keys that are not models. A model name can never start with an underscore. */
const OWN_DEFAULT = "__own-default__";
const TYPE_ONE = "__type-one__";

/**
 * Which model an AI uses: its own default, one from the list, or a name the student types.
 * Lists of models go stale, and an account may have a model the list does not know, so typing
 * a name is always possible.
 */
export function ModelPicker({
  providerLabel,
  models,
  value,
  isDisabled,
  onChange,
}: {
  providerLabel: string;
  /** The models to offer right now. */
  models: readonly ProviderModel[];
  /** The saved model, or `null` for the AI's own default. */
  value: string | null;
  isDisabled: boolean;
  /** Saves the choice. Resolves to `null` when saved, or to the sentence why not. */
  onChange: (model: string | null) => Promise<string | null>;
}) {
  const [typing, setTyping] = useState(false);
  // A model saved earlier (or typed) that is not in the list is still shown as the choice.
  const listed = value !== null && !models.some((model) => model.id === value)
    ? [...models, { id: value, label: value }]
    : models;

  return (
    <div className="flex flex-col gap-3">
      <Select
        className="w-96 max-w-full"
        value={typing ? TYPE_ONE : (value ?? OWN_DEFAULT)}
        isDisabled={isDisabled}
        onChange={(key) => {
          if (key === TYPE_ONE) {
            setTyping(true);
            return;
          }
          setTyping(false);
          void onChange(key === OWN_DEFAULT || key === null ? null : String(key));
        }}
      >
        <Label>Model</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            <ListBox.Item id={OWN_DEFAULT} textValue={`${providerLabel}’s own default`}>
              {providerLabel}’s own default
              <ListBox.ItemIndicator />
            </ListBox.Item>
            {listed.map((model) => (
              <ListBox.Item key={model.id} id={model.id} textValue={model.label}>
                {model.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
            <ListBox.Item id={TYPE_ONE} textValue="Another model…">
              Another model…
              <ListBox.ItemIndicator />
            </ListBox.Item>
          </ListBox>
        </Select.Popover>
      </Select>

      {typing ? (
        <TypedModel
          onCancel={() => setTyping(false)}
          onSave={async (name) => {
            const refusal = await onChange(name);
            if (refusal === null) setTyping(false);
            return refusal;
          }}
        />
      ) : null}
    </div>
  );
}

function TypedModel({
  onSave,
  onCancel,
}: {
  onSave: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const model = name.trim();
    if (model === "" || pending) return;
    if (!isModelId(model)) {
      setError("That is not a usable model name. Use letters, numbers and . _ : / - only, without spaces.");
      return;
    }
    setPending(true);
    const refusal = await onSave(model);
    setPending(false);
    if (refusal !== null) setError(refusal);
  };

  return (
    <Form onSubmit={submit} className="flex flex-wrap items-start gap-2">
      <TextField
        autoFocus
        className="w-96 max-w-full"
        aria-label="Model name"
        value={name}
        onChange={(next) => {
          setName(next);
          setError(null);
        }}
        isInvalid={error !== null}
        isReadOnly={pending}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <Input placeholder="The model’s name, exactly as the provider writes it" autoComplete="off" spellCheck="false" />
        <FieldError>{error}</FieldError>
      </TextField>
      <Button type="submit" variant="outline" isDisabled={name.trim() === ""} isPending={pending}>
        Save
      </Button>
      <Button variant="ghost" onPress={onCancel} isDisabled={pending}>
        Cancel
      </Button>
    </Form>
  );
}

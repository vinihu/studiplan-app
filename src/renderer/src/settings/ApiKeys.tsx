import { Button, FieldError, Form, Input, Label, TextField } from "@heroui/react";
import { Check } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { API_KEY_VENDORS, VENDOR_LABELS } from "@shared/providers";
import type { ApiKeyStatus, ApiKeyVendor } from "@shared/providers";
import { ai } from "../ai/api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useDialog } from "../components/use-dialog";
import { TestResult, useProviderTest } from "./provider-test";

/**
 * The keys of the API-key provider: one per vendor. A key goes to the main process once, when
 * it is saved, and never comes back: the field empties, and all this screen ever knows is
 * whether one is saved.
 */
export function ApiKeys({
  status,
  onStatus,
}: {
  /** Which vendors have a key. `null` while that is being read. */
  status: ApiKeyStatus | null;
  /** A key was saved or removed. */
  onStatus: (status: ApiKeyStatus) => void;
}) {
  const remove = useDialog<ApiKeyVendor>();

  return (
    <div className="flex flex-col gap-4" data-testid="api-keys">
      <p className="max-w-xl text-sm leading-relaxed text-muted">
        You get a key on the provider’s own website. It is kept on this computer, encrypted by the
        operating system, and sent only to the provider it belongs to.
      </p>
      <ul className="flex flex-col gap-5">
        {API_KEY_VENDORS.map((vendor) => (
          <VendorKey
            key={vendor}
            vendor={vendor}
            saved={status === null ? null : status.saved.includes(vendor)}
            onStatus={onStatus}
            onRemove={() => remove.open(vendor)}
          />
        ))}
      </ul>

      <ConfirmDialog
        isOpen={remove.isOpen}
        onClose={remove.close}
        title={`Remove the ${remove.target ? VENDOR_LABELS[remove.target] : ""} key?`}
        confirmLabel="Remove key"
        onConfirm={async () => {
          if (!remove.target) return null;
          const result = await ai.clearApiKey(remove.target);
          if (!result.ok) return result.error.message;
          onStatus(result.value);
          return null;
        }}
      >
        {remove.target
          ? `The key is removed from this computer. It stays valid at ${VENDOR_LABELS[remove.target]} until you delete it there.`
          : null}
      </ConfirmDialog>
    </div>
  );
}

function VendorKey({
  vendor,
  saved,
  onStatus,
  onRemove,
}: {
  vendor: ApiKeyVendor;
  saved: boolean | null;
  onStatus: (status: ApiKeyStatus) => void;
  onRemove: () => void;
}) {
  const name = VENDOR_LABELS[vendor];
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const test = useProviderTest("api-key", vendor);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (key.trim() === "" || pending) return;
    setPending(true);
    const result = await ai.saveApiKey(vendor, key);
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    // The key is not kept in the page a moment longer than needed.
    setKey("");
    setError(null);
    test.reset();
    onStatus(result.value);
  };

  return (
    <li data-vendor={vendor}>
      {saved ? (
        <div>
          <p className="text-sm font-medium">{name}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="flex min-h-9 items-center gap-2 text-sm">
              <Check aria-hidden className="size-4 shrink-0" />
              A key is saved
            </p>
            {test.state.status === "running" ? (
              <Button variant="outline" size="sm" onPress={test.cancel}>
                Cancel
              </Button>
            ) : (
              <Button variant="outline" size="sm" aria-label={`Test the ${name} key`} onPress={() => void test.run()}>
                {test.state.status === "idle" ? "Test" : "Test again"}
              </Button>
            )}
            <Button variant="ghost" size="sm" className="text-muted" aria-label={`Remove the ${name} key`} onPress={onRemove}>
              Remove
            </Button>
          </div>
          <TestResult state={test.state} name={name} />
        </div>
      ) : (
        <Form onSubmit={save} className="flex flex-wrap items-end gap-2">
          <TextField
            className="w-96 max-w-full"
            type="password"
            value={key}
            onChange={(next) => {
              setKey(next);
              setError(null);
            }}
            isInvalid={error !== null}
            isReadOnly={pending}
            isDisabled={saved === null}
          >
            <Label>{name}</Label>
            <Input placeholder={`Paste your ${name} key`} autoComplete="off" spellCheck="false" />
            <FieldError className="max-w-xl">{error}</FieldError>
          </TextField>
          <Button
            type="submit"
            variant="outline"
            aria-label={`Save the ${name} key`}
            isDisabled={key.trim() === ""}
            isPending={pending}
            // Lines up with the field, not with the refusal under it.
            className={error ? "self-start mt-6" : ""}
          >
            Save
          </Button>
        </Form>
      )}
      {vendor === "google" ? (
        <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted">
          Google offers a free tier for some Gemini models, with limits; on the free tier Google
          may use your content to improve its products.
        </p>
      ) : null}
    </li>
  );
}

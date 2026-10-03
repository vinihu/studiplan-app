import { Button, Chip, Spinner } from "@heroui/react";
import { Check, ChevronDown, CircleAlert, Minus } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type {
  AiSettings,
  ApiKeyStatus,
  ProviderDetection,
  ProviderInfo,
  ProviderModel,
} from "@shared/providers";
import { ai } from "../ai/api";
import { READS, REQUIREMENTS } from "../ai/labels";
import { IconButton } from "../components/IconButton";
import { ApiKeys } from "./ApiKeys";
import { ModelPicker } from "./ModelPicker";
import { TestResult, useProviderTest } from "./provider-test";

/**
 * One AI in Settings. The head is always there: its name, what the check found, and the one
 * action that fits (use it, stop using it, or set it up). The details below it (what it needs,
 * what it can read, the model, Test, and for the API key the keys) are open for the AI in use
 * and folded away for the others, so four of them can be read at a glance.
 */
export function ProviderBlock({
  provider,
  detection,
  checking,
  settings,
  isSuggested,
  isOpen,
  onToggle,
  onChoose,
  onClear,
  onSettings,
  onError,
  revision,
  apiKeys,
  onApiKeys,
}: {
  provider: ProviderInfo;
  /** `null` until the first check has answered. */
  detection: ProviderDetection | null;
  checking: boolean;
  settings: AiSettings | null;
  /** The first ready AI while none is chosen: its "Use" button is the screen's one blue button. */
  isSuggested: boolean;
  isOpen: boolean;
  onToggle: (open: boolean) => void;
  onChoose: () => void;
  onClear: () => void;
  onSettings: (settings: AiSettings) => void;
  onError: (message: string | null) => void;
  /** Changes when what is installed, or which keys are saved, may have changed. */
  revision: number;
  apiKeys: ApiKeyStatus | null;
  onApiKeys: (status: ApiKeyStatus) => void;
}) {
  const detailsId = useId();
  const test = useProviderTest(provider.id);
  const [models, setModels] = useState<{ revision: number; list: ProviderModel[] } | null>(null);

  const id = provider.id;
  useEffect(() => {
    let left = false;
    void ai.listModels(id).then((list) => {
      if (!left) setModels({ revision, list });
    });
    return () => {
      left = true;
    };
  }, [id, revision]);

  const isDefault = settings?.defaultProvider === id;
  const isReady = detection?.status === "ready";
  const model = settings?.models[id] ?? null;
  const usesKeys = id === "api-key";
  const noKeyYet = usesKeys && apiKeys !== null && apiKeys.saved.length === 0;

  const chooseModel = async (next: string | null): Promise<string | null> => {
    const result = await ai.setModel(id, next);
    if (!result.ok) {
      // A typed name shows its refusal next to the field; a picked one, at the top.
      if (next === null) onError(result.error.message);
      return result.error.message;
    }
    onError(null);
    onSettings(result.value);
    // What the last test said was about the other model.
    test.reset();
    return null;
  };

  return (
    <li className="border-t border-separator" data-provider={id}>
      {/* The head is a row that acts: pressed anywhere, it opens or folds the details, like the
          rows of a list. Its own buttons act for themselves, and the arrow is the keyboard's way. */}
      <div
        className="flex cursor-pointer items-start justify-between gap-4 px-4 py-5 transition-colors duration-100 ease-out hover:bg-default/50 motion-reduce:transition-none"
        data-testid="provider-head"
        // A second quick press is a press, not "select this word": the sentence can still be
        // selected by dragging over it.
        onMouseDown={(event) => {
          if (event.detail > 1) event.preventDefault();
        }}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button, a, input")) return;
          // Dragging to select the sentence ends in a click too; that is not a press.
          if (event.detail === 1 && window.getSelection()?.toString()) return;
          onToggle(!isOpen);
        }}
      >
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.9375rem] font-semibold">
            {provider.label}
            {isDefault ? (
              <Chip size="sm" color="accent" variant="soft">
                Used for new results
              </Chip>
            ) : null}
          </h3>
          <Status detection={detection} checking={checking} onSettingsScreen={usesKeys} />
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {settings === null ? null : isDefault ? (
            <Button variant="ghost" size="sm" className="text-muted" onPress={onClear}>
              Stop using
            </Button>
          ) : isReady ? (
            <Button variant={isSuggested ? "primary" : "outline"} size={isSuggested ? "md" : "sm"} onPress={onChoose}>
              Use {provider.label}
            </Button>
          ) : !isOpen && detection !== null ? (
            <Button variant="outline" size="sm" onPress={() => onToggle(true)}>
              {usesKeys ? "Add a key" : "Set up"}
            </Button>
          ) : null}
          <IconButton
            label={`Details of ${provider.label}`}
            tooltip={isOpen ? "Hide details" : "Show details"}
            aria-expanded={isOpen}
            aria-controls={detailsId}
            onPress={() => onToggle(!isOpen)}
          >
            <ChevronDown
              aria-hidden
              className={`transition-transform duration-100 ease-out motion-reduce:transition-none ${isOpen ? "rotate-180" : ""}`}
            />
          </IconButton>
        </div>
      </div>

      {isOpen ? (
        <div id={detailsId} className="-mt-1 flex flex-col gap-5 px-4 pb-5" data-testid="provider-details">
          <p className="max-w-xl text-sm leading-relaxed text-muted">
            {REQUIREMENTS[id]} {READS[id]}
          </p>

          {usesKeys ? <ApiKeys status={apiKeys} onStatus={onApiKeys} /> : null}

          {/* A model for the API key means something only once there is a key to use it with. */}
          {usesKeys && (apiKeys === null || noKeyYet) ? null : (
          <div>
            <div className="flex flex-wrap items-end gap-3">
              <ModelPicker
                providerLabel={provider.label}
                models={models?.list ?? provider.suggestedModels}
                value={model}
                isDisabled={settings === null}
                onChange={chooseModel}
              />
              {/* Each key has its own Test; this one would only repeat one of them. */}
              {usesKeys ? null : test.state.status === "running" ? (
                <Button variant="outline" onPress={test.cancel}>
                  Cancel
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onPress={() => void test.run()}
                  isDisabled={detection === null || detection.status === "not-installed"}
                >
                  {test.state.status === "idle" ? "Test" : "Test again"}
                </Button>
              )}
            </div>
            {models !== null && models.list.length === 0 ? (
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted" data-testid="no-models">
                {id === "ollama"
                    ? "No models were found on this computer. Do what the line at the top says, then press Check again. You can also type a model’s name."
                    : "No models were found. You can still type a model’s name."}
              </p>
            ) : null}
            <TestResult state={test.state} name={provider.label} />
          </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

/**
 * What the check found, in words. "Ready" is a plain check mark and ordinary text: green is kept
 * for a correct answer. Red appears only when checking itself went wrong.
 */
export function Status({
  detection,
  checking,
  onSettingsScreen = false,
}: {
  detection: ProviderDetection | null;
  checking: boolean;
  /** The API key's "…in Settings" sentence is said differently on the Settings screen itself. */
  onSettingsScreen?: boolean;
}) {
  if (detection === null) {
    return checking ? (
      <p className="mt-1.5 flex items-center gap-2 text-sm text-muted" data-status="checking">
        <Spinner size="sm" color="current" />
        Checking…
      </p>
    ) : (
      <p className="mt-1.5 text-sm text-muted" data-status="unknown">
        Not checked yet. Press Check again.
      </p>
    );
  }
  const isError = detection.status === "error";
  const isReady = detection.status === "ready";
  const Icon = isReady ? Check : isError ? CircleAlert : Minus;
  const detail =
    onSettingsScreen && detection.status === "not-signed-in" ? "No key is saved yet." : detection.detail;
  return (
    <p
      className={`mt-1.5 flex items-start gap-2 text-sm leading-relaxed ${checking ? "opacity-60" : ""}`}
      data-status={detection.status}
    >
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${isError ? "text-danger" : isReady ? "" : "text-muted"}`} />
      <span className={isReady ? "" : "text-muted"}>{detail}</span>
    </p>
  );
}

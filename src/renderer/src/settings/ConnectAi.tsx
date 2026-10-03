import { Skeleton } from "@heroui/react";
import { useEffect, useState } from "react";
import type { AiSettings, ApiKeyStatus, ProviderId } from "@shared/providers";
import { ai } from "../ai/api";
import { ErrorNotice } from "../components/ErrorNotice";
import { Notice } from "../components/Notice";
import { OUTDENT } from "../components/RowList";
import { ProviderBlock } from "./ProviderBlock";
import { firstReady } from "./use-providers";
import type { Providers } from "./use-providers";

/**
 * The AIs of Settings, one block each.
 *
 * The blue-button rule: a filled button appears only while no AI is chosen, on the first one
 * that is ready. Every other "Use …" is an outline, and once an AI is chosen there is no filled
 * button here at all: the chosen one carries the blue "you are here" mark instead.
 */
export function ConnectAi({
  providers,
  settings,
  onSettings,
}: {
  providers: Providers;
  settings: AiSettings | null;
  onSettings: (settings: AiSettings) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyStatus | null>(null);
  /** Blocks the student opened or closed by hand. The others follow which AI is in use. */
  const [opened, setOpened] = useState<Partial<Record<ProviderId, boolean>>>({});
  /** Goes up when a key is saved or removed: the model lists depend on it. */
  const [keyRevision, setKeyRevision] = useState(0);

  useEffect(() => {
    let left = false;
    void ai.apiKeyStatus().then((status) => {
      if (!left) setApiKeys(status);
    });
    return () => {
      left = true;
    };
  }, []);

  const choose = async (id: ProviderId | null) => {
    const result = await ai.setDefault(id);
    if (result.ok) {
      setError(null);
      onSettings(result.value);
    } else setError(result.error.message);
  };

  const list = Array.isArray(providers.list) ? providers.list : [];
  const chosen = settings?.defaultProvider ?? null;
  const suggested = settings !== null && chosen === null ? firstReady(providers) : null;

  return (
    <>
      {error ? (
        <Notice status="danger" role="alert" title="That could not be saved" onClose={() => setError(null)}>
          {error}
        </Notice>
      ) : null}

      {providers.failed ? (
        <ErrorNotice
          title="Studiplan could not check what is installed"
          message="Press Check again. If that does not help, close the app and open it again."
          onRetry={providers.checkAgain}
        />
      ) : null}

      {providers.list === "failed" ? (
        <ErrorNotice title="The list of AIs could not be loaded" message="Close the app and open it again." />
      ) : null}

      {providers.list === null ? (
        <div className={`${OUTDENT} flex flex-col gap-3 px-4 pt-5`} aria-busy="true" aria-label="Loading">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-80" />
        </div>
      ) : null}

      {list.length > 0 ? (
        // As wide as the row lists of the other screens: each AI's head is a row that acts.
        <ul className="-mx-4 flex flex-col border-b border-separator" aria-label="AIs you can connect">
          {list.map((provider) => (
            <ProviderBlock
              key={provider.id}
              provider={provider}
              detection={providers.detectionOf(provider.id)}
              checking={providers.checking}
              settings={settings}
              isSuggested={suggested === provider.id}
              isOpen={opened[provider.id] ?? (chosen === provider.id || suggested === provider.id)}
              onToggle={(open) => setOpened((current) => ({ ...current, [provider.id]: open }))}
              onChoose={() => void choose(provider.id)}
              onClear={() => void choose(null)}
              onSettings={onSettings}
              onError={setError}
              revision={providers.revision * 1000 + keyRevision}
              apiKeys={apiKeys}
              onApiKeys={(status) => {
                setApiKeys(status);
                setKeyRevision((current) => current + 1);
                // Whether the API key is "ready" depends on whether a key is saved.
                providers.checkAgain();
              }}
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}

import { Button, Chip, Skeleton } from "@heroui/react";
import { useRef } from "react";
import type { ReactNode } from "react";
import type { LibraryInfo } from "@shared/library";
import type { AiSettings, ProviderId } from "@shared/providers";
import { ai } from "../ai/api";
import { REQUIREMENTS } from "../ai/labels";
import logo from "../assets/logo-small.svg";
import { useFocusOnMount } from "../components/use-escape";
import { LibraryFolder } from "../settings/LibraryFolder";
import type { LibraryFolderChange } from "../settings/use-library-folder";
import { Status } from "../settings/ProviderBlock";
import { firstReady, useProviders } from "../settings/use-providers";

/**
 * The first thing a new student sees, once: where the library lives, and which AI to use.
 * Both have a sensible answer already (the default folder; the first AI that is ready), so the
 * screen can be left with one click, and "Skip for now" is always there.
 *
 * The blue button is the next thing to do: "Use …" while a ready AI is waiting to be chosen,
 * "Start" once one is chosen or none is ready.
 */
export function FirstRunScreen({
  info,
  aiSettings,
  onAiSettings,
  folder,
  onDone,
  onOpenSettings,
}: {
  info: LibraryInfo | null;
  aiSettings: AiSettings | null;
  onAiSettings: (settings: AiSettings) => void;
  folder: LibraryFolderChange;
  /** Start, or Skip for now: the app proper opens and this screen does not come back. */
  onDone: () => void;
  /** Leaves for Settings, where keys and models are set up. */
  onOpenSettings: () => void;
}) {
  const providers = useProviders();
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnMount(heading);

  const list = Array.isArray(providers.list) ? providers.list : [];
  const chosen = aiSettings?.defaultProvider ?? null;
  const suggested = aiSettings !== null && chosen === null ? firstReady(providers) : null;
  const detected = list.length > 0 && list.every((provider) => providers.detectionOf(provider.id) !== null);
  const noneReady = detected && firstReady(providers) === null;

  const choose = async (id: ProviderId) => {
    const result = await ai.setDefault(id);
    if (result.ok) onAiSettings(result.value);
  };

  return (
    <div className="scrollbar h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]" data-testid="first-run">
      <div className="mx-auto flex w-full max-w-2xl flex-col px-10 pt-(--screen-top) pb-16">
        <div className="flex items-center justify-between gap-6">
          <p className="flex items-center gap-2.5 text-[0.9375rem] font-semibold tracking-tight">
            <img src={logo} alt="" width={36} height={31} className="h-7.75 w-9 shrink-0" />
            Studiplan
          </p>
          <Button variant="ghost" size="sm" className="-mr-3 text-muted" onPress={onDone}>
            Skip for now
          </Button>
        </div>

        <h1 ref={heading} tabIndex={-1} className="mt-12 text-2xl leading-8 font-semibold tracking-tight outline-none">
          Two things before you start
        </h1>
        <p className="mt-2 max-w-xl text-[0.9375rem] leading-relaxed text-muted">
          Studiplan turns your study materials into summaries, cheat sheets, flashcards and practice
          tests, with your own AI, for free. Both of these can be changed later in Settings.
        </p>

        <Step number={1} title="Where your library lives">
          <p className="max-w-xl text-sm leading-relaxed text-muted">
            Your subjects and materials are saved as ordinary folders on this computer.
          </p>
          <LibraryFolder info={info} folder={folder} showOpen={false} />
        </Step>

        <Step number={2} title="Connect your own AI">
          <p className="max-w-xl text-sm leading-relaxed text-muted">
            {noneReady
              ? "None of these is ready on this computer yet. Each line says what it needs. You can set one up now in Settings, or later."
              : `${OWN_AI} Your files are sent to it only when you press a button, and nowhere else.`}
          </p>

          {providers.list === null ? (
            <div className="flex flex-col gap-3 border-t border-separator pt-4" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-72" />
            </div>
          ) : null}

          {providers.list === "failed" ? (
            <p className="text-sm text-muted">The list of AIs could not be loaded. You can connect one later in Settings.</p>
          ) : null}

          {list.length > 0 ? (
            <ul className="flex flex-col border-b border-separator" aria-label="AIs you can connect">
              {list.map((provider) => {
                const detection = providers.detectionOf(provider.id);
                const isChosen = chosen === provider.id;
                return (
                  <li
                    key={provider.id}
                    className="flex items-start justify-between gap-4 border-t border-separator py-4"
                    data-provider={provider.id}
                  >
                    <div className="min-w-0">
                      <h3 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.9375rem] font-semibold">
                        {provider.label}
                        {isChosen ? (
                          <Chip size="sm" color="accent" variant="soft">
                            Used for new results
                          </Chip>
                        ) : null}
                      </h3>
                      {detection !== null && detection.status !== "ready" ? (
                        // Not ready: what it needs says more than what was not found.
                        <p className="mt-1.5 text-sm leading-relaxed text-muted" data-status={detection.status}>
                          {REQUIREMENTS[provider.id]}
                        </p>
                      ) : (
                        <Status detection={detection} checking={providers.checking} />
                      )}
                    </div>
                    {!isChosen && detection?.status === "ready" && aiSettings !== null ? (
                      <Button
                        variant={suggested === provider.id ? "primary" : "outline"}
                        size={suggested === provider.id ? "md" : "sm"}
                        className="shrink-0"
                        onPress={() => void choose(provider.id)}
                      >
                        Use {provider.label}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {noneReady ? (
            <div>
              <Button variant="outline" onPress={onOpenSettings}>
                Open Settings
              </Button>
            </div>
          ) : null}
        </Step>

        <div className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button variant={suggested === null ? "primary" : "outline"} onPress={onDone}>
            Start
          </Button>
          {chosen === null && detected ? (
            <p className="text-sm text-muted">
              {noneReady
                ? "You can add your files now and connect an AI when you want to make something."
                : "Without an AI you can still add and read your files."}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** What "free" means here, said the same way as in Settings. */
const OWN_AI =
  "Studiplan is free and never charges for AI. It uses the one you already have, and you pay that provider as you already do.";

/** One of the two steps. The number is the order to do them in, which is worth saying here. */
function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <section className="mt-10 flex flex-col gap-4">
      <h2 className="flex items-baseline gap-2.5 text-base font-semibold">
        <span className="text-muted tabular-nums">{number}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

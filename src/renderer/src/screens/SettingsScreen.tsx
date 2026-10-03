import { Button, Spinner } from "@heroui/react";
import { RefreshCw } from "lucide-react";
import type { LibraryInfo } from "@shared/library";
import type { AiSettings } from "@shared/providers";
import { BackLink } from "../components/BackLink";
import { Page, PageHeader, Section } from "../components/Page";
import { OUTDENT } from "../components/RowList";
import { useEscape } from "../components/use-escape";
import { ConnectAi } from "../settings/ConnectAi";
import { LibraryFolder } from "../settings/LibraryFolder";
import type { LibraryFolderChange } from "../settings/use-library-folder";
import { useProviders } from "../settings/use-providers";

/**
 * Settings: which AI makes the results, and where the library is kept. The pieces live in
 * `src/renderer/src/settings/`; the first-run screen uses the same ones.
 */
export function SettingsScreen({
  backLabel,
  onBack,
  info,
  aiSettings,
  onAiSettings,
  folder,
}: {
  /** Where the way back leads: the subject's name, or "Library". */
  backLabel: string;
  onBack: () => void;
  /** Where the library is, or `null` while that is not known. */
  info: LibraryInfo | null;
  /** The chosen AI and models, or `null` while they are being read. */
  aiSettings: AiSettings | null;
  onAiSettings: (settings: AiSettings) => void;
  /** The flow that changes the library folder; the sidebar's "Change…" uses the same one. */
  folder: LibraryFolderChange;
}) {
  const providers = useProviders();
  useEscape(onBack);

  return (
    <Page>
      <PageHeader
        above={<BackLink label={backLabel} onPress={onBack} />}
        title="Settings"
      />
      <div className="flex flex-col gap-12">
        <Section
          title="Connect your AI"
          actions={
            <Button
              variant="outline"
              onPress={providers.checkAgain}
              isPending={providers.checking}
              isDisabled={providers.list === null}
            >
              {providers.checking ? <Spinner size="sm" color="current" /> : <RefreshCw aria-hidden />}
              Check again
            </Button>
          }
        >
          <p className="-mt-2 mb-2 max-w-xl text-sm leading-relaxed text-muted">
            Studiplan is free and never charges for AI. It makes everything with the AI you already
            have: your Claude or ChatGPT subscription (through Claude Code or Codex), a model on this
            computer (Ollama), or your own API key. You pay that provider as you already do. Your
            files are sent to it only when you press a button, and nowhere else.
          </p>
          <ConnectAi providers={providers} settings={aiSettings} onSettings={onAiSettings} />
        </Section>

        <Section title="Library folder">
          <p className="-mt-2 mb-2 max-w-xl text-sm leading-relaxed text-muted">
            Your subjects, materials and results are ordinary folders and files in here. You can back
            them up or open them with any other program.
          </p>
          <div className={`${OUTDENT} px-4 pt-5`}>
            <LibraryFolder info={info} folder={folder} />
          </div>
        </Section>
      </div>
    </Page>
  );
}

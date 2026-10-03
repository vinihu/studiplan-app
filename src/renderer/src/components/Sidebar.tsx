import { Button, ListBox, Skeleton } from "@heroui/react";
import { FolderPen, Plus, Settings } from "lucide-react";
import type { ReactNode } from "react";
import type { LibraryInfo, Subject } from "@shared/library";
import logo from "../assets/logo-small.svg";
import { FOLDER_FIXED_SHORT } from "../settings/LibraryFolder";
import type { QueryState } from "../library/use-library-query";
import { IconButton } from "./IconButton";

/**
 * What every row of the sidebar shares, a subject or an action: one height, one inset (the text
 * or the icon starts under the "S" of the app's name), one corner, one size of type. Hover and
 * the focus ring come from HeroUI and are the same grey and the same ring on both kinds.
 */
const ROW = "h-9 min-h-9 cursor-pointer gap-2 px-2 text-sm";

/** "You are here": the blue tint. It still answers the pointer, a step darker, because it still acts. */
const CURRENT = "bg-accent-soft font-semibold text-accent hover:bg-accent-soft-hover";

/** Reaches into the small space between two rows of a list, so no strip between them is dead. */
const GAPLESS = "before:absolute before:inset-x-0 before:-inset-y-0.5 before:content-['']";

/**
 * A row of the sidebar that does something: New subject, Settings. As wide as the subjects'
 * rows and pressed anywhere along it.
 */
function SidebarAction({
  icon,
  children,
  onPress,
  isCurrent = false,
  isDisabled = false,
}: {
  icon: ReactNode;
  children: ReactNode;
  onPress: () => void;
  /** This row is the screen that is open. */
  isCurrent?: boolean;
  isDisabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      fullWidth
      aria-current={isCurrent ? "page" : false}
      // The icon's own negative margin is taken off, so it starts exactly where a subject's name does.
      className={`${ROW} justify-start [&_svg]:mx-0 ${isCurrent ? CURRENT : "text-muted"}`}
      onPress={onPress}
      isDisabled={isDisabled}
    >
      {icon}
      {children}
    </Button>
  );
}

/**
 * The left column of every screen: the app's name, the subjects, and at the bottom Settings and
 * where the library is kept. One thing here is blue, and it says where you are: the selected
 * subject, or Settings while that is open.
 */
export function Sidebar({
  subjects,
  selected,
  onSelect,
  onNewSubject,
  info,
  settingsOpen,
  onSettings,
  aiMissing,
  activity,
  onChangeFolder,
  folderBusy,
}: {
  subjects: QueryState<Subject[]>;
  /** Folder name of the subject the user is in. Pressing it again goes to its list of materials. */
  selected: string | null;
  onSelect: (subject: string) => void;
  onNewSubject: () => void;
  info: LibraryInfo | null;
  settingsOpen: boolean;
  onSettings: () => void;
  /** True when no AI has been chosen yet. Said quietly next to Settings, where it is fixed. */
  aiMissing: boolean;
  /** What is being made right now, or how it ended: shown above Settings while there is any. */
  activity?: ReactNode;
  /** Lets the user pick another folder for the library: the same flow as in Settings. */
  onChangeFolder: () => void;
  /** A folder picker is open already. */
  folderBusy: boolean;
}) {
  const list = subjects.status === "ready" ? subjects.value : [];

  return (
    <nav
      aria-label="Library"
      className="flex w-60 shrink-0 flex-col border-r border-separator bg-background"
    >
      {/* The head is the window's title bar here: dragging it moves the window. */}
      <p className="app-drag flex items-center gap-2 px-5 pt-(--sidebar-top) pb-6 text-[0.9375rem] font-semibold tracking-tight">
        {/* Wider than tall, drawn to its edges: its own proportions, starting where the rows' text starts. */}
        <img src={logo} alt="" width={30} height={26} className="h-6.5 w-7.5 shrink-0" />
        Studiplan
      </p>

      <h2 id="sidebar-subjects" className="px-5 pb-1.5 text-xs font-medium text-muted">
        Subjects
      </h2>

      <div className="scrollbar min-h-0 shrink overflow-y-auto px-2">
        {subjects.status === "loading" ? (
          <div className="flex flex-col gap-3 px-3 py-2" aria-hidden>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
        ) : null}

        {subjects.status === "ready" && list.length === 0 ? (
          <p className="px-3 py-1.5 text-sm text-muted">None yet</p>
        ) : null}

        {list.length > 0 ? (
          <ListBox
            aria-labelledby="sidebar-subjects"
            // Pressing a subject goes to it, also when it is the one already marked: from a
            // material or a result that is the way to its list. So this is a list of actions
            // with a mark on the current one, not a selection that ignores a second press.
            selectionMode="none"
            onAction={(key) => {
              if (typeof key === "string") onSelect(key);
            }}
            // Keeps HeroUI's 4px inset: the list clips, and the focus ring needs the room.
          >
            {list.map((subject) => (
              <ListBox.Item
                key={subject.id}
                id={subject.id}
                textValue={subject.id}
                aria-current={!settingsOpen && subject.id === selected ? "page" : undefined}
                className={`${ROW} ${GAPLESS} justify-between ${
                  !settingsOpen && subject.id === selected ? CURRENT : ""
                }`}
              >
                <span className="truncate">{subject.id}</span>
                <span className="shrink-0 text-xs font-normal text-muted tabular-nums">
                  {subject.materialCount}
                </span>
              </ListBox.Item>
            ))}
          </ListBox>
        ) : null}
      </div>

      {/* Under the list, not inside it: with many subjects it stays where it is. */}
      <div className="px-3 pt-1">
        <SidebarAction icon={<Plus aria-hidden />} onPress={onNewSubject} isDisabled={subjects.status !== "ready"}>
          New subject
        </SidebarAction>
      </div>

      <div className="mt-auto" />
      {activity}

      <div className="px-3 pt-2 pb-2">
        <SidebarAction icon={<Settings aria-hidden />} onPress={onSettings} isCurrent={settingsOpen}>
          Settings
          {aiMissing && !settingsOpen ? (
            <span className="ml-auto text-xs font-normal text-muted">No AI yet</span>
          ) : null}
        </SidebarAction>
      </div>

      {info ? (
        <div className="border-t border-separator px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs leading-relaxed text-muted">Saved in</p>
            {/* A small icon on the label's line: it keeps a comfortable area to press through its
                padding, pulled in by a negative margin so the footer is no taller for it. When the
                folder cannot be changed it stays reachable, so its tooltip can say why. */}
            <IconButton
              label="Change folder…"
              tooltip={info.fixedByEnvironment ? FOLDER_FIXED_SHORT : "Change folder…"}
              className={`-my-1.5 -mr-1.5 size-7 min-w-0 text-muted [&_svg]:size-4 ${
                info.fixedByEnvironment ? "pointer-events-auto cursor-not-allowed opacity-50 hover:bg-transparent" : ""
              }`}
              {...(info.fixedByEnvironment ? { "aria-disabled": true } : {})}
              isDisabled={folderBusy && !info.fixedByEnvironment}
              onPress={() => {
                if (!info.fixedByEnvironment) onChangeFolder();
              }}
            >
              <FolderPen aria-hidden />
            </IconButton>
          </div>
          <p className="mt-1 truncate text-xs leading-relaxed" title={info.root} data-testid="sidebar-root">
            {info.root}
          </p>
          {info.fixedByEnvironment ? (
            <p className="mt-2 text-xs leading-relaxed text-muted" data-testid="sidebar-root-fixed">
              {FOLDER_FIXED_SHORT}
            </p>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}

import { Dropdown, Label } from "@heroui/react";
import { Ellipsis } from "lucide-react";
import { IconButton } from "./IconButton";

/**
 * The "…" button with Rename and Delete, used for a subject, a material and a result. With
 * `onOpenFolder` it also offers to show that folder in the system's file manager. The menu opens
 * under the button's right end, and its order is always the same: what is harmless first, the
 * one that deletes last and in red.
 */
export function OptionsMenu({
  label,
  onRename,
  onDelete,
  onOpenFolder,
}: {
  /** Says whose options these are, for screen readers: `Options for Biology`. */
  label: string;
  /** Left out for something that cannot be renamed (a result whose file cannot be read). */
  onRename?: () => void;
  onDelete: () => void;
  onOpenFolder?: () => void;
}) {
  return (
    <Dropdown>
      <IconButton label={label} tooltip="Options">
        <Ellipsis aria-hidden />
      </IconButton>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={label}
          onAction={(key) => {
            if (key === "rename") onRename?.();
            if (key === "delete") onDelete();
            if (key === "open-folder") onOpenFolder?.();
          }}
        >
          {onOpenFolder ? (
            <Dropdown.Item id="open-folder" textValue="Open folder">
              <Label>Open folder</Label>
            </Dropdown.Item>
          ) : null}
          {onRename ? (
            <Dropdown.Item id="rename" textValue="Rename">
              <Label>Rename</Label>
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item id="delete" textValue="Delete" variant="danger">
            <Label>Delete</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

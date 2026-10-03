import { Table } from "@heroui/react";
import type { HTMLAttributes, ReactNode } from "react";

/**
 * The list of rows used for materials, files and results: one build, so the three cannot drift
 * apart. A row is pressed anywhere along its width to open it; the control at its end (a menu,
 * a remove button) acts on its own and never opens the row.
 *
 * The list is pulled out by its cells' padding, so the first column's text lines up with the
 * headings above it and the hover runs a little wider than the text. Column headings are there
 * for screen readers only.
 */
export function RowList({
  label,
  columns,
  onOpen,
  children,
  frame,
}: {
  /** What the list holds, for screen readers: `Materials in Biology`. */
  label: string;
  /** The columns' names. The first one names the row. */
  columns: readonly { name: string; className?: string }[];
  /** A row was pressed (or Enter on it). Gets the row's `id`. */
  onOpen: (id: string) => void;
  /** `Table.Row`s, each with one `Table.Cell` per column. */
  children: ReactNode;
  /** Props for the list's outer box, e.g. drop handlers. */
  frame?: HTMLAttributes<HTMLDivElement>;
}) {
  return (
    <div className={OUTDENT} {...frame}>
      <Table variant="secondary">
        <Table.ScrollContainer>
          <Table.Content aria-label={label} onRowAction={(key) => onOpen(String(key))}>
            <Table.Header className="sr-only">
              {columns.map((column, index) => (
                <Table.Column key={column.name} isRowHeader={index === 0} {...(column.className ? { className: column.className } : {})}>
                  {column.name}
                </Table.Column>
              ))}
            </Table.Header>
            <Table.Body>{children}</Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </div>
  );
}

/**
 * A hairline above a block that runs as wide as a row list's: for what stands in a list's place
 * (its loading and empty states) and for row-like blocks that are not tables.
 */
export const OUTDENT = "-mx-4 border-t border-separator";

/** A row that opens something when pressed. */
export const ROW_OPENS = "cursor-pointer";

/**
 * A row that opens nothing (a result whose file cannot be read): no pointer and no highlight
 * under the pointer, because a highlight says "you can act here".
 */
export const ROW_STATIC = "cursor-default [&:hover_td]:bg-transparent";

/** The first cell: takes the room that is left, and cuts a long name off instead of wrapping. */
export const CELL_NAME = "w-full max-w-0";

/** A cell of secondary facts: a count, a kind, a date. */
export const CELL_FACT = "text-muted whitespace-nowrap tabular-nums";

/** The last cell, holding the row's own small button: less padding, so rows keep one height. */
export const CELL_CONTROL = "py-1.5";

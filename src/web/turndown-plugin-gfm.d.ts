declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  /** GFM plugin — enables strikethrough, tables, task list items, and highlighted code blocks. */
  export function gfm(service: TurndownService): void;
  export function highlightedCodeBlock(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}

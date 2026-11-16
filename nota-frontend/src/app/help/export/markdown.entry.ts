// Entry bundled by scripts/export-help.mjs (Node, no Angular): renders docs/help/HELP_AR.md.
import { HELP_SECTIONS_AR } from '../content/ar';
import { PERMISSION_CATALOG } from '../generated/permission-catalog';
import { helpToMarkdown } from '../help-markdown';

export function renderHelpMarkdown(): string {
  return helpToMarkdown({
    sections: HELP_SECTIONS_AR,
    permissionLabel: (key) => PERMISSION_CATALOG.permissions[key]?.ar ?? key,
  });
}

// Online Stage Help: everything the help screens need, in ONE lazy chunk (loaded by HelpContentService on first use), so the
// content never reaches the main bundle.
import { HELP_SECTIONS_AR } from './content/ar';
import { PERMISSION_CATALOG } from './generated/permission-catalog';
import { buildSearchIndex } from './help-search';
import { HelpSection } from './help.models';

export interface HelpData {
  sections: readonly HelpSection[];
  byId: ReadonlyMap<string, HelpSection>;
  index: ReturnType<typeof buildSearchIndex>;
  permissionLabel: (key: string) => string;
}

export function createHelpData(): HelpData {
  // English UI: the Arabic content for now (HelpContent.locale; an `en` folder with the same shape is added later).
  const sections = HELP_SECTIONS_AR;
  return {
    sections,
    byId: new Map(sections.map((section) => [section.id, section])),
    index: buildSearchIndex(sections),
    permissionLabel: (key) => PERMISSION_CATALOG.permissions[key]?.ar ?? key,
  };
}

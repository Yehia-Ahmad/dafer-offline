// docs/help/HELP_AR.md is generated from the help data by scripts/export-help.mjs; this spec fails when it is stale.
// The file is imported as text (angular.json test option `loader: { ".md": "text" }`).
import helpMarkdown from '../../../../docs/help/HELP_AR.md';
import { HELP_SECTIONS_AR } from './content/ar';
import { PERMISSION_CATALOG } from './generated/permission-catalog';
import { helpToMarkdown } from './help-markdown';

describe('help review export (Online Stage Help)', () => {
  it('docs/help/HELP_AR.md is up to date (run: node scripts/export-help.mjs)', () => {
    const expected = helpToMarkdown({ sections: HELP_SECTIONS_AR, permissionLabel: (key) => PERMISSION_CATALOG.permissions[key]?.ar ?? key });
    const actual = helpMarkdown.replace(/\r\n/g, '\n');
    expect(actual === expected).withContext('HELP_AR.md differs from the help data').toBeTrue();
  });

  it('has every section in order', () => {
    const headings = helpMarkdown.split(/\r?\n/).filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
    expect(headings).toEqual(HELP_SECTIONS_AR.map((section) => section.title));
  });
});

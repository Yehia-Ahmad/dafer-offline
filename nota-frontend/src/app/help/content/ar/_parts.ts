// Helpers for writing help sections: the fixed sub-headings of a page section (the brief's ten parts).
import { HelpBlock, HelpPart } from '../../help.models';

/** The heading of one of the ten parts (its text comes from HELP_PART_TITLES). */
export const part = (name: HelpPart): HelpBlock => ({ type: 'heading', text: '', part: name });

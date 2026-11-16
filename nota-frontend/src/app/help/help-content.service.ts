import { Injectable } from '@angular/core';
import type { HelpData } from './help-data';
import type { HelpSection } from './help.models';
import { sectionForUrl } from './help-route-match';

/** Loads the help content (one lazy chunk) once and answers "which section explains this URL". */
@Injectable({ providedIn: 'root' })
export class HelpContentService {
  private loading: Promise<HelpData> | null = null;

  load(): Promise<HelpData> {
    this.loading ??= import('./help-data').then((module) => module.createHelpData());
    return this.loading;
  }

  /** The section of a page URL; the support section when no section lists the route (the coverage spec prevents that). */
  async sectionFor(url: string): Promise<HelpSection> {
    const data = await this.load();
    return sectionForUrl(url, data.sections) ?? data.byId.get('support')!;
  }
}

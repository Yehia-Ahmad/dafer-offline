import { Injectable, inject, signal } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { LayoutService } from '../core/layout/layout.service';
import { HelpContentService } from './help-content.service';

/**
 * The contextual "؟": on the desktop it opens the side panel on the current page's section (the page stays where it is);
 * on the phone it opens that section as a full page (/help/<id>), and back returns to the page.
 */
@Injectable({ providedIn: 'root' })
export class HelpPanelService {
  private readonly router = inject(Router);
  private readonly layout = inject(LayoutService);
  private readonly content = inject(HelpContentService);

  /** The section shown in the desktop panel; null = closed. */
  readonly sectionId = signal<string | null>(null);

  constructor() {
    // A page link inside the panel navigates; the panel closes with the navigation.
    this.router.events.subscribe((event) => { if (event instanceof NavigationStart) this.close(); });
  }

  async openForCurrentPage(): Promise<void> {
    const section = await this.content.sectionFor(this.router.url);
    if (this.layout.isMobile()) {
      await this.router.navigate(['/help', section.id]);
    } else {
      this.sectionId.set(section.id);
    }
  }

  /** Switch the open panel to another section (a "related" or section link inside the panel). */
  show(id: string): void {
    this.sectionId.set(id);
  }

  close(): void {
    this.sectionId.set(null);
  }
}

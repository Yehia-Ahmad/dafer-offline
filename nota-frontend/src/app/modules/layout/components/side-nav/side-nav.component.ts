import { Location } from '@angular/common';
import { Component, HostListener, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HelpButtonComponent } from '../../../../help/components/help-button.component';
import { HelpPanelComponent } from '../../../../help/components/help-panel.component';
import { HelpPanelService } from '../../../../help/help-panel.service';
import { CustomSidenavComponent } from '../../custom-sidenav/custom-sidenav.component';
import { SidebarStateService } from '../../nav/sidebar-state.service';

/**
 * App frame, rendered once in app.html around <router-outlet> (Stage 9): Nota sidebar on the inline-start side,
 * a slim top bar (back button; menu button for the drawer on narrow windows) and the page container.
 * Direction comes from <html dir>, set by LanguageService. Styles: src/styles/_shell.scss.
 */
@Component({
  selector: 'app-side-nav',
  standalone: true,
  imports: [CustomSidenavComponent, TranslatePipe, HelpButtonComponent, HelpPanelComponent],
  templateUrl: './side-nav.component.html',
})
export class SideNavComponent {
  protected readonly state = inject(SidebarStateService);
  /** Online Stage Help: the "؟" side panel (its component and the content load only when it is first opened). */
  protected readonly help = inject(HelpPanelService);
  private readonly _location = inject(Location);

  goBack() {
    this._location.back();
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.state.drawerOpen()) this.state.closeDrawer();
  }
}

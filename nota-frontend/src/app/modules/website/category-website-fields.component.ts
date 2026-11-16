import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaButtonDirective } from '../shared/ui';
import { CategoryWebsite, ProductVisibilityMode, VisibilityChoice } from './website.models';
import { WebsiteService } from './website.service';

/**
 * Online Stage 3: "show on website" and the order of a category, inside the category edit dialog (the parent shows it only
 * with website.manage and only for an existing category). Saves on its own through PUT /api/website/categories/:id.
 */
@Component({
  selector: 'app-category-website-fields',
  imports: [FormsModule, TranslatePipe, NotaButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="cwf" data-test="category-website">
      <span class="cwf__title">{{ 'website.category.title' | translate }}</span>
      <!-- Online Stage 5A: follows the website's mode. "marked": tick to show. "all": tick to hide. -->
      @if (mode() === 'all') {
        <label class="cwf__check"><input type="checkbox" data-field="category-website-hidden" [ngModel]="choice() === 'hide'" (ngModelChange)="choice.set($event ? 'hide' : null)" [ngModelOptions]="{ standalone: true }" /> {{ 'website.category.hide' | translate }}</label>
        <span class="nota-hint">{{ 'website.category.hideHint' | translate }}</span>
      } @else {
        <label class="cwf__check"><input type="checkbox" data-field="category-website-visible" [ngModel]="choice() === 'show'" (ngModelChange)="choice.set($event ? 'show' : null)" [ngModelOptions]="{ standalone: true }" /> {{ 'website.category.visible' | translate }}</label>
        <span class="nota-hint">{{ 'website.category.visibleHint' | translate }}</span>
      }
      <label class="nota-label" for="cwf-order">{{ 'website.category.order' | translate }}</label>
      <input id="cwf-order" type="text" inputmode="numeric" dir="ltr" class="nota-input cwf__num" data-field="category-website-order"
        [ngModel]="sortOrder()" (ngModelChange)="sortOrder.set($event)" [ngModelOptions]="{ standalone: true }" />
      @if (orderInvalid()) { <span class="nota-error" role="alert">{{ 'website.category.orderInvalid' | translate }}</span> }
      <div class="cwf__footer">
        @if (outcome(); as result) {
          <span class="cwf__status" role="status" [class.is-error]="result === 'error'">{{ (result === 'saved' ? 'website.category.saved' : 'website.category.saveFailed') | translate }}</span>
        }
        <button type="button" notaButton data-action="save-category-website" [disabled]="saving() || orderInvalid() || !dirty()" (click)="save()">
          {{ (saving() ? 'website.category.saving' : 'website.category.save') | translate }}
        </button>
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .cwf { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); }
    .cwf__title { font-weight: 700; }
    .cwf__check { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .cwf__num { max-width: 140px; text-align: left; }
    .cwf__footer { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
    .cwf__status { margin-inline-end: auto; font-size: 14px; color: var(--success); }
    .cwf__status.is-error { color: var(--danger); }
  `],
})
export class CategoryWebsiteFieldsComponent {
  private readonly service = inject(WebsiteService);
  private readonly destroyRef = inject(DestroyRef);

  readonly categoryId = input.required<string>();
  readonly website = input<CategoryWebsite | undefined | null>(undefined);

  protected readonly mode = signal<ProductVisibilityMode>('marked');
  protected readonly choice = signal<VisibilityChoice>(null);
  protected readonly sortOrder = signal<string>('0');
  protected readonly saving = signal(false);
  protected readonly outcome = signal<'saved' | 'error' | null>(null);
  private saved = '';

  constructor() {
    this.service.getSettings().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (settings) => this.mode.set(settings.productVisibility), error: () => undefined });
    effect(() => {
      const incoming = this.website();
      untracked(() => {
        if (this.saved && this.dirty()) return;
        this.apply(incoming);
      });
    });
  }

  protected orderInvalid(): boolean {
    return !/^-?\d{1,6}$/.test(String(this.sortOrder()).trim());
  }

  protected dirty(): boolean {
    return this.snapshot() !== this.saved;
  }

  protected save(): void {
    if (this.orderInvalid()) return;
    this.outcome.set(null);
    this.saving.set(true);
    this.service
      .saveCategoryWebsite(this.categoryId(), { visibility: this.choice(), sortOrder: Number(this.sortOrder()) })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.apply(response.website);
          this.saving.set(false);
          this.outcome.set('saved');
        },
        error: () => {
          this.saving.set(false);
          this.outcome.set('error');
        },
      });
  }

  private apply(website: CategoryWebsite | undefined | null): void {
    this.choice.set(website?.visibility ?? null);
    this.sortOrder.set(String(website?.sortOrder ?? 0));
    this.saved = this.snapshot();
  }

  private snapshot(): string {
    return JSON.stringify([this.choice(), String(this.sortOrder()).trim()]);
  }
}

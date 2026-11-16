import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { UnsavedWorkService } from '../../core/unsaved-work/unsaved-work.service';
import { NotaButtonDirective } from '../shared/ui';
import { ProductVisibilityMode, ProductWebsite, VisibilityChoice, WEBSITE_LIMITS } from './website.models';
import { WebsiteService } from './website.service';

/**
 * Online Stage 3: the "الموقع" section of the product form (edit mode; the parent shows it only with website.manage).
 * It loads and saves on its own through /api/website/products/:id (the product itself and the products list carry no website
 * images), so the product's own save and its request body are untouched:
 * show on website, a website description and up to 4 extra images.
 */
@Component({
  selector: 'app-product-website-section',
  imports: [FormsModule, TranslatePipe, NotaButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="nota-card pws" data-test="product-website">
      <h2 class="pws__title">{{ 'website.product.title' | translate }}</h2>
      <!-- Online Stage 5A: the control follows the website's mode. "marked": tick to show. "all": tick to hide. -->
      @if (mode() === 'all') {
        <label class="pws__check"><input type="checkbox" data-field="website-hidden" [ngModel]="choice() === 'hide'" (ngModelChange)="setHidden($event)" [ngModelOptions]="{ standalone: true }" /> {{ 'website.product.hide' | translate }}</label>
        <p class="nota-hint">{{ 'website.product.hideHint' | translate }}</p>
      } @else {
        <label class="pws__check"><input type="checkbox" data-field="website-visible" [ngModel]="choice() === 'show'" (ngModelChange)="setShown($event)" [ngModelOptions]="{ standalone: true }" /> {{ 'website.product.visible' | translate }}</label>
        <p class="nota-hint">{{ 'website.product.visibleHint' | translate }}</p>
      }

      <label class="nota-label" for="pws-description">{{ 'website.product.description' | translate }}</label>
      <textarea id="pws-description" rows="4" class="nota-textarea" data-field="website-description" [maxLength]="limits.productDescription"
        [ngModel]="description()" (ngModelChange)="description.set($event)" [ngModelOptions]="{ standalone: true }"></textarea>

      <span class="nota-label">{{ 'website.product.images' | translate }}</span>
      <div class="pws__images">
        @for (image of images(); track $index; let i = $index) {
          <div class="pws__image">
            <img [src]="image" [alt]="('website.product.image' | translate) + ' ' + (i + 1)" />
            <button type="button" notaButton="danger" icon data-action="remove-website-image" (click)="removeImage(i)"
              [attr.aria-label]="'website.product.removeImage' | translate" [title]="'website.product.removeImage' | translate">×</button>
          </div>
        }
        @if (images().length < limits.productImages) {
          <label class="nota-btn nota-btn--secondary pws__add" data-action="add-website-image">
            + {{ 'website.product.addImage' | translate }}
            <input type="file" accept="image/*" hidden (change)="onImageSelected($event)" />
          </label>
        }
      </div>
      <span class="nota-hint">{{ 'website.product.imagesHint' | translate: { count: limits.productImages } }}</span>
      @if (imageError(); as key) { <span class="nota-error" role="alert">{{ key | translate }}</span> }

      <div class="pws__footer">
        @if (outcome(); as result) {
          <span class="pws__status" role="status" [class.is-error]="result.kind === 'error'">
            {{ result.kind === 'saved' ? ('website.product.saved' | translate) : (result.message || ('website.product.saveFailed' | translate)) }}
          </span>
        }
        <button type="button" notaButton="primary" data-action="save-website" [disabled]="saving() || loading() || !dirty()" (click)="save()">
          {{ (saving() ? 'website.product.saving' : 'website.product.save') | translate }}
        </button>
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .pws { display: flex; flex-direction: column; gap: 10px; }
    .pws__title { margin: 0; font-size: 16px; font-weight: 700; }
    .pws__check { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .pws__images { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .pws__image { position: relative; width: 96px; height: 96px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); padding: 4px;
      display: flex; align-items: center; justify-content: center; }
    .pws__image img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .pws__image button { position: absolute; top: 4px; inset-inline-end: 4px; }
    .pws__add { cursor: pointer; }
    .pws__footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px; }
    .pws__status { margin-inline-end: auto; font-size: 14px; font-weight: 500; color: var(--success); }
    .pws__status.is-error { color: var(--danger); }
  `],
})
export class ProductWebsiteSectionComponent {
  private readonly service = inject(WebsiteService);
  private readonly destroyRef = inject(DestroyRef);

  readonly productId = input.required<string>();

  protected readonly limits = WEBSITE_LIMITS;
  /** The website's product visibility mode (GET /api/website/settings). */
  protected readonly mode = signal<ProductVisibilityMode>('marked');
  protected readonly choice = signal<VisibilityChoice>(null);
  protected readonly description = signal('');
  protected readonly images = signal<string[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly imageError = signal<string | null>(null);
  protected readonly outcome = signal<{ kind: 'saved' } | { kind: 'error'; message: string } | null>(null);
  private saved = '';

  constructor() {
    // The product opened (or another one): read its website data, images included.
    effect(() => {
      const id = this.productId();
      untracked(() => this.load(id));
    });
    this.destroyRef.onDestroy(inject(UnsavedWorkService).register('product-website', () => this.dirty() && !this.saving()));
  }

  protected setShown(on: boolean): void {
    this.choice.set(on ? 'show' : null);
  }

  protected setHidden(on: boolean): void {
    this.choice.set(on ? 'hide' : null);
  }

  private load(id: string): void {
    this.loading.set(true);
    this.outcome.set(null);
    this.service.getSettings().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (settings) => this.mode.set(settings.productVisibility), error: () => undefined });
    this.service.getProductWebsite(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        this.apply(response.website);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.outcome.set({ kind: 'error', message: '' });
      },
    });
  }

  protected dirty(): boolean {
    return this.snapshot() !== this.saved;
  }

  protected removeImage(index: number): void {
    this.images.update((list) => list.filter((_, i) => i !== index));
  }

  protected onImageSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.images().length >= WEBSITE_LIMITS.productImages) return;
    if (!file.type.startsWith('image/')) return this.imageError.set('website.product.invalidType');
    if (file.size > WEBSITE_LIMITS.imageBytes) return this.imageError.set('website.product.tooLarge');
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      this.images.update((list) => [...list, reader.result as string]);
      this.imageError.set(null);
    };
    reader.onerror = () => this.imageError.set('website.product.readFailed');
    reader.readAsDataURL(file);
  }

  protected save(): void {
    this.outcome.set(null);
    this.saving.set(true);
    this.service
      .saveProductWebsite(this.productId(), { visibility: this.choice(), description: this.description().trim(), images: this.images() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.apply(response.website);
          this.saving.set(false);
          this.outcome.set({ kind: 'saved' });
        },
        error: (error) => {
          this.saving.set(false);
          this.outcome.set({ kind: 'error', message: typeof error?.error?.message === 'string' ? error.error.message : '' });
        },
      });
  }

  private apply(website: ProductWebsite | undefined | null): void {
    this.choice.set(website?.visibility ?? null);
    this.description.set(website?.description || '');
    this.images.set([...(website?.images || [])]);
    this.saved = this.snapshot();
  }

  private snapshot(): string {
    return JSON.stringify([this.choice(), this.description().trim(), this.images()]);
  }
}

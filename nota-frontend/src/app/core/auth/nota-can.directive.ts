import { Directive, TemplateRef, ViewContainerRef, effect, inject, input } from '@angular/core';
import { AuthService } from './auth.service';

/**
 * Stage 14: shows its template only when the signed-in user has the permission(s); otherwise the
 * `else` template (e.g. the permission-locked pattern) or nothing. The backend still checks every
 * action: this only hides what the user cannot use.
 *
 *   <button *notaCan="'sales.delete'">…</button>
 *   <button *notaCan="['products.importExport', 'products.viewCost']">…</button>   (all of them)
 *   <section *notaCan="['returns.view', 'returns.create']; any: true">…</section>   (any of them)
 *   <button *notaCan="'sales.delete'; else locked">…</button>
 *   <ng-template #locked><nota-locked-action … /></ng-template>
 */
@Directive({ selector: '[notaCan]' })
export class NotaCanDirective {
  private readonly auth = inject(AuthService);
  private readonly template = inject(TemplateRef<unknown>);
  private readonly container = inject(ViewContainerRef);

  readonly notaCan = input.required<string | readonly string[]>();
  readonly notaCanAny = input(false);
  readonly notaCanElse = input<TemplateRef<unknown> | null>(null);

  private shown: 'main' | 'else' | null = null;

  constructor() {
    effect(() => {
      const keys = this.notaCan();
      const list = typeof keys === 'string' ? [keys] : [...keys];
      const allowed = this.notaCanAny() ? this.auth.hasAny(...list) : this.auth.hasAll(...list);
      const elseTemplate = this.notaCanElse();
      const want = allowed ? 'main' : elseTemplate ? 'else' : null;
      if (want === this.shown) return;
      this.container.clear();
      if (want === 'main') this.container.createEmbeddedView(this.template);
      else if (want === 'else' && elseTemplate) this.container.createEmbeddedView(elseTemplate);
      this.shown = want;
    });
  }
}

import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { LayoutService } from '../../../core/layout/layout.service';
import { MobSheetComponent } from '../../mobile/mob-sheet.component';
import { NotaButtonDirective, NotaDialogShellComponent } from '../../shared/ui';
import { GeoPlace, PublishAdInput, PublishCta, PublishGoal, PublishOptions, PublishSpecInput, PublishStepName, PublishView } from '../marketing.models';
import { MarketingService } from '../marketing.service';

export const PUBLISH_STEP_ORDER: PublishStepName[] = ['validate', 'campaign', 'images', 'adset', 'creatives', 'ads', 'link'];
/** Every code the server can answer with while publishing; each has an Arabic and English text (marketing.publish.errors.*). */
export const PUBLISH_ERROR_CODES = [
  'NOT_CONNECTED', 'PUBLISH_PERMISSION_MISSING', 'PAGE_REQUIRED', 'CURRENCY_NOT_SUPPORTED', 'PAYMENT_REQUIRED', 'SITE_NOT_PUBLIC', 'INVALID_GOAL', 'INVALID_BUDGET', 'INVALID_DATE',
  'INVALID_AUDIENCE', 'INVALID_ADS', 'IMAGE_INVALID', 'PIXEL_REQUIRED', 'RATE_REQUIRED', 'BUDGET_OVER_CEILING', 'BUDGET_TOO_LOW', 'BUDGET_CONFLICT', 'PUBLISH_RUNNING', 'PUBLISH_FINISHED',
  'PLATFORM_NOT_LINKABLE', 'ACCOUNT_CHANGED', 'PAGE_NOT_ALLOWED', 'IMAGE_REJECTED', 'AD_POLICY', 'APP_NOT_LIVE', 'INVALID_PARAMETER', 'TOKEN_INVALID', 'RATE_LIMITED', 'NETWORK', 'META_ERROR',
  'PUBLISH_NOT_ALLOWED', 'PUBLISH_NOT_FOUND', 'CAMPAIGN_NOT_FOUND',
];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ADS = 5;

interface AdDraft {
  primaryText: string; headline: string; description: string; cta: PublishCta;
  imageKind: 'upload' | 'product';
  imageId: string; uploading: boolean; uploadName: string; thumb: string;
  productId: string; productName: string; productImageIndex: number;
  landingKind: 'campaign' | 'product'; landingProductId: string; landingProductName: string;
}
const blankAd = (): AdDraft => ({
  primaryText: '', headline: '', description: '', cta: 'SHOP_NOW', imageKind: 'upload', imageId: '', uploading: false, uploadName: '', thumb: '',
  productId: '', productName: '', productImageIndex: 0, landingKind: 'campaign', landingProductId: '', landingProductName: '',
});

/**
 * Online Stage 7C: «حملة فيسبوك جديدة». Goal, budget (with the ceiling shown), audience, 1 to 5 ads, then a review with Meta's own preview.
 * Publishing creates everything PAUSED: nothing spends until the owner switches the campaign on from the campaign page. Meta takes the money
 * from the card of the ad account in Ads Manager, never from Nota.
 */
@Component({
  selector: 'app-meta-publish-wizard',
  imports: [FormsModule, NgTemplateOutlet, DecimalPipe, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, MobSheetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #body>
      <div class="pw" data-test="publish-wizard">
        @if (loading()) { <p class="pw__muted">{{ 'marketing.meta.link.loading' | translate }}</p> }
        @else if (options(); as o) {
          @if (!o.ready) {
            <div class="pw__box pw__box--bad" data-test="publish-blockers" role="alert">
              <strong>{{ 'marketing.publish.blocked' | translate }}</strong>
              @for (b of o.blockers; track b.code) {
                <span data-test="publish-blocker" [attr.data-code]="b.code">{{ 'marketing.publish.errors.' + b.code | translate }}@if (b.missing?.length) { <b dir="ltr"> {{ b.missing!.join(', ') }}</b> }</span>
              }
              <small>{{ 'marketing.publish.blockedHelp' | translate }}</small>
            </div>
          } @else if (phase() === 'form') {
            <ol class="pw__steps" data-test="publish-steps">
              @for (n of [1, 2, 3, 4, 5]; track n) { <li [class.pw__on]="step() === n" [class.pw__done]="step() > n">{{ 'marketing.publish.steps.' + n | translate }}</li> }
            </ol>

            @switch (step()) {
              @case (1) {
                <div class="pw__group" data-test="step-goal" role="radiogroup">
                  <label class="pw__opt"><input type="radio" name="goal" value="traffic" data-test="goal-traffic" [ngModel]="goal()" (ngModelChange)="goal.set($event)" /> <span><b>{{ 'marketing.publish.goal.traffic' | translate }}</b><small>{{ 'marketing.publish.goal.trafficHint' | translate }}</small></span></label>
                  <label class="pw__opt" [class.pw__off]="!o.salesAllowed"><input type="radio" name="goal" value="sales" data-test="goal-sales" [disabled]="!o.salesAllowed" [ngModel]="goal()" (ngModelChange)="goal.set($event)" /> <span><b>{{ 'marketing.publish.goal.sales' | translate }}</b><small>{{ 'marketing.publish.goal.salesHint' | translate }}</small></span></label>
                  @if (!o.salesAllowed) { <p class="pw__warn" data-test="sales-unavailable">{{ (o.pixel.configured ? 'marketing.publish.goal.pixelInvisible' : 'marketing.publish.goal.pixelMissing') | translate }}</p> }
                  @else if (!o.pixel.lastFiredTime) { <p class="pw__warn" data-test="pixel-never-fired">{{ 'marketing.publish.goal.pixelNeverFired' | translate }}</p> }
                </div>
              }
              @case (2) {
                <div class="pw__group" data-test="step-budget">
                  <div class="pw__row">
                    <label class="pw__opt"><input type="radio" name="budgetType" value="daily" data-test="budget-daily" [ngModel]="budgetType()" (ngModelChange)="budgetType.set($event)" /> {{ 'marketing.publish.budget.daily' | translate }}</label>
                    <label class="pw__opt"><input type="radio" name="budgetType" value="lifetime" data-test="budget-lifetime" [ngModel]="budgetType()" (ngModelChange)="budgetType.set($event)" /> {{ 'marketing.publish.budget.lifetime' | translate }}</label>
                  </div>
                  <label class="pw__f">{{ 'marketing.publish.budget.amount' | translate }} ({{ o.currency }})
                    <input [class]="input() + ' nota-num'" type="number" inputmode="decimal" min="1" step="0.01" name="amount" data-test="budget-amount" [ngModel]="amount()" (ngModelChange)="amount.set($event)" />
                  </label>
                  <p class="pw__muted" data-test="ceiling-hint">{{ (budgetType() === 'daily' ? 'marketing.publish.budget.ceilingDaily' : 'marketing.publish.budget.ceilingTotal') | translate: { amount: (budgetType() === 'daily' ? o.ceiling.dailyEgp : o.ceiling.totalEgp) } }}</p>
                  @if (o.currency !== 'EGP') {
                    @if (egp() !== null) { <p class="pw__muted" data-test="egp-equivalent">{{ 'marketing.publish.budget.egp' | translate }}: <b class="nota-num">{{ egp() | number: '1.0-2' }}</b></p> }
                    @else { <p class="pw__warn" data-test="needs-rate">{{ 'marketing.publish.budget.needsRate' | translate }}</p> }
                  }
                  @if (overCeiling()) { <p class="nota-error" role="alert" data-test="over-ceiling">{{ 'marketing.publish.errors.BUDGET_OVER_CEILING' | translate }}</p> }
                  @if (o.minDailyBudgetMinor && budgetType() === 'daily') { <p class="pw__muted">{{ 'marketing.publish.budget.min' | translate }}: <b class="nota-num">{{ o.minDailyBudgetMinor / 100 }} {{ o.currency }}</b></p> }
                  <label class="pw__f">{{ 'marketing.publish.budget.start' | translate }}
                    <input [class]="input() + ' nota-num'" type="datetime-local" name="startTime" data-test="budget-start" [ngModel]="startTime()" (ngModelChange)="startTime.set($event)" />
                    <small>{{ 'marketing.publish.budget.startHint' | translate }}</small>
                  </label>
                  @if (budgetType() === 'lifetime') {
                    <label class="pw__f">{{ 'marketing.publish.budget.end' | translate }}
                      <input [class]="input() + ' nota-num'" type="datetime-local" name="endTime" data-test="budget-end" [ngModel]="endTime()" (ngModelChange)="endTime.set($event)" />
                    </label>
                  }
                </div>
              }
              @case (3) {
                <div class="pw__group" data-test="step-audience">
                  <p class="pw__muted">{{ 'marketing.publish.audience.country' | translate }}</p>
                  <label class="pw__opt"><input type="checkbox" name="advantage" data-test="advantage" [ngModel]="advantage()" (ngModelChange)="advantage.set($event)" /> <span><b>{{ 'marketing.publish.audience.advantage' | translate }}</b><small>{{ 'marketing.publish.audience.advantageHint' | translate }}</small></span></label>
                  @if (advantage()) {
                    <label class="pw__f">{{ 'marketing.publish.audience.ageMin' | translate }}
                      <select [class]="input()" name="ageMinAdv" data-test="age-min-advantage" [ngModel]="ageMin()" (ngModelChange)="ageMin.set(+$event)">
                        @for (a of advantageAges; track a) { <option [ngValue]="a">{{ a }}</option> }
                      </select>
                    </label>
                  } @else {
                    <div class="pw__row">
                      <label class="pw__f">{{ 'marketing.publish.audience.ageMin' | translate }}<input [class]="input() + ' nota-num'" type="number" min="18" max="65" name="ageMin" data-test="age-min" [ngModel]="ageMin()" (ngModelChange)="ageMin.set(+$event)" /></label>
                      <label class="pw__f">{{ 'marketing.publish.audience.ageMax' | translate }}<input [class]="input() + ' nota-num'" type="number" min="18" max="65" name="ageMax" data-test="age-max" [ngModel]="ageMax()" (ngModelChange)="ageMax.set(+$event)" /></label>
                      <label class="pw__f">{{ 'marketing.publish.audience.gender' | translate }}
                        <select [class]="input()" name="gender" data-test="gender" [ngModel]="gender()" (ngModelChange)="gender.set($event)">
                          <option value="all">{{ 'marketing.publish.audience.all' | translate }}</option>
                          <option value="male">{{ 'marketing.publish.audience.male' | translate }}</option>
                          <option value="female">{{ 'marketing.publish.audience.female' | translate }}</option>
                        </select>
                      </label>
                    </div>
                  }
                  <label class="pw__f">{{ 'marketing.publish.audience.places' | translate }}
                    <input [class]="input()" type="search" name="geo" data-test="geo-search" [placeholder]="'marketing.publish.audience.placesHint' | translate" [ngModel]="geoQuery()" (ngModelChange)="searchGeo($event)" />
                  </label>
                  @for (g of geoResults(); track g.key) {
                    <button type="button" [class]="btn()" data-test="geo-result" (click)="addPlace(g)">{{ g.name }}@if (g.region) { <small> · {{ g.region }}</small> }</button>
                  }
                  <div class="pw__chips" data-test="geo-chosen">
                    @for (g of locations(); track g.key) { <span class="nota-pill">{{ g.name }} <button type="button" class="pw__x" [attr.aria-label]="'mobile.common.close' | translate" (click)="removePlace(g.key)">×</button></span> }
                    @if (!locations().length) { <small class="pw__muted">{{ 'marketing.publish.audience.wholeEgypt' | translate }}</small> }
                  </div>
                </div>
              }
              @case (4) {
                <div class="pw__group" data-test="step-ads">
                  @for (ad of ads(); track $index; let i = $index) {
                    <div class="pw__ad" data-test="ad-form" [attr.data-index]="i">
                      <div class="pw__row pw__between"><strong>{{ 'marketing.publish.ads.ad' | translate }} {{ i + 1 }}</strong>
                        @if (ads().length > 1) { <button type="button" [class]="btn()" data-action="remove-ad" (click)="removeAd(i)">{{ 'marketing.publish.ads.remove' | translate }}</button> }</div>
                      <div class="pw__row">
                        <label class="pw__opt"><input type="radio" [name]="'imgKind' + i" value="upload" [ngModel]="ad.imageKind" (ngModelChange)="patchAd(i, { imageKind: 'upload' })" /> {{ 'marketing.publish.ads.upload' | translate }}</label>
                        <label class="pw__opt"><input type="radio" [name]="'imgKind' + i" value="product" data-test="image-product" [ngModel]="ad.imageKind" (ngModelChange)="patchAd(i, { imageKind: 'product' })" /> {{ 'marketing.publish.ads.fromProduct' | translate }}</label>
                      </div>
                      @if (ad.imageKind === 'upload') {
                        <input type="file" accept="image/jpeg,image/png" [attr.data-test]="'image-file-' + i" (change)="pickFile(i, $event)" />
                        @if (ad.thumb) { <img class="pw__thumb" [src]="ad.thumb" alt="" /> }
                        @if (ad.uploading) { <small class="pw__muted" data-test="image-uploading">{{ 'marketing.publish.ads.uploading' | translate }}</small> }
                        <small class="pw__muted">{{ 'marketing.publish.ads.imageRules' | translate }}</small>
                      } @else {
                        <input [class]="input()" type="search" [name]="'productSearch' + i" data-test="product-search" [placeholder]="'marketing.publish.ads.searchProduct' | translate" (ngModelChange)="searchProduct(i, 'image', $event)" ngModel />
                        @if (pickingIndex() === i && pickingFor() === 'image') { @for (p of productResults(); track p.id) { <button type="button" [class]="btn()" data-test="product-result" (click)="chooseProduct(i, p)">{{ p.name }}</button> } }
                        @if (ad.productId) {
                          <span class="pw__muted">{{ ad.productName }}</span>
                          <label class="pw__f">{{ 'marketing.publish.ads.whichImage' | translate }}
                            <select [class]="input()" [name]="'imgIndex' + i" [ngModel]="ad.productImageIndex" (ngModelChange)="patchAd(i, { productImageIndex: +$event })">
                              <option [ngValue]="0">{{ 'marketing.publish.ads.mainImage' | translate }}</option>
                              @for (n of [1, 2, 3, 4]; track n) { <option [ngValue]="n">{{ 'marketing.publish.ads.siteImage' | translate }} {{ n }}</option> }
                            </select>
                          </label>
                        }
                      }
                      <label class="pw__f">{{ 'marketing.publish.ads.primaryText' | translate }}
                        <textarea [class]="input()" rows="3" [name]="'primary' + i" data-test="ad-primary" maxlength="500" [ngModel]="ad.primaryText" (ngModelChange)="patchAd(i, { primaryText: $event })"></textarea>
                        <small [class.pw__warnText]="ad.primaryText.length > 450">{{ ad.primaryText.length }} / 500</small>
                      </label>
                      <label class="pw__f">{{ 'marketing.publish.ads.headline' | translate }}
                        <input [class]="input()" [name]="'headline' + i" data-test="ad-headline" [ngModel]="ad.headline" (ngModelChange)="patchAd(i, { headline: $event })" />
                        <small [class.pw__warnText]="ad.headline.length > 40" data-test="headline-count">{{ ad.headline.length }} / 40@if (ad.headline.length > 40) { · {{ 'marketing.publish.ads.headlineLong' | translate }} }</small>
                      </label>
                      <label class="pw__f">{{ 'marketing.publish.ads.description' | translate }}
                        <input [class]="input()" [name]="'desc' + i" [ngModel]="ad.description" (ngModelChange)="patchAd(i, { description: $event })" />
                      </label>
                      <label class="pw__f">{{ 'marketing.publish.ads.cta' | translate }}
                        <select [class]="input()" [name]="'cta' + i" data-test="ad-cta" [ngModel]="ad.cta" (ngModelChange)="patchAd(i, { cta: $event })">
                          @for (c of o.ctas; track c) { <option [value]="c">{{ 'marketing.publish.cta.' + c | translate }}</option> }
                        </select>
                      </label>
                      <label class="pw__f">{{ 'marketing.publish.ads.landing' | translate }}
                        <select [class]="input()" [name]="'landing' + i" [ngModel]="ad.landingKind" (ngModelChange)="patchAd(i, { landingKind: $event })">
                          <option value="campaign">{{ 'marketing.publish.ads.landingCampaign' | translate }}</option>
                          <option value="product">{{ 'marketing.publish.ads.landingProduct' | translate }}</option>
                        </select>
                      </label>
                      @if (ad.landingKind === 'product') {
                        <input [class]="input()" type="search" [name]="'landingSearch' + i" [placeholder]="'marketing.publish.ads.searchProduct' | translate" (ngModelChange)="searchProduct(i, 'landing', $event)" ngModel />
                        @if (pickingIndex() === i && pickingFor() === 'landing') { @for (p of productResults(); track p.id) { <button type="button" [class]="btn()" (click)="chooseLanding(i, p)">{{ p.name }}</button> } }
                        @if (ad.landingProductId) { <span class="pw__muted">{{ ad.landingProductName }}</span> }
                      }
                    </div>
                  }
                  @if (ads().length < maxAds) { <button type="button" [class]="btn()" data-action="add-ad" (click)="addAd()">{{ 'marketing.publish.ads.add' | translate }}</button> }
                </div>
              }
              @case (5) {
                <div class="pw__group" data-test="step-review">
                  <p><b>{{ 'marketing.publish.review.summary' | translate }}</b></p>
                  <ul class="pw__list">
                    <li>{{ 'marketing.publish.goal.' + goal() | translate }}</li>
                    <li data-test="review-budget">{{ (budgetType() === 'daily' ? 'marketing.publish.budget.daily' : 'marketing.publish.budget.lifetime') | translate }}: <b class="nota-num">{{ amount() }} {{ o.currency }}</b></li>
                    <li>{{ ads().length }} {{ 'marketing.publish.review.ads' | translate }}</li>
                    <li>{{ 'marketing.publish.review.page' | translate }}: {{ o.page?.name }}@if (o.instagram) { · {{ o.instagram.name }} }</li>
                  </ul>
                  @for (w of warnings(); track w) { <p class="pw__warn" data-test="publish-warning">{{ w }}</p> }
                  <p class="pw__muted" data-test="paused-note">{{ 'marketing.publish.review.pausedNote' | translate }}</p>
                  <p class="pw__muted">{{ 'marketing.publish.review.payNote' | translate }}</p>
                  @if (draft(); as d) {
                    @for (a of ads(); track $index; let i = $index) {
                      <div class="pw__row">
                        <span>{{ 'marketing.publish.ads.ad' | translate }} {{ i + 1 }}</span>
                        <button type="button" [class]="btn()" data-action="preview-feed" [disabled]="busy()" (click)="preview(d.publishId, i, 'feed')">{{ 'marketing.publish.review.previewFeed' | translate }}</button>
                        <button type="button" [class]="btn()" data-action="preview-instagram" [disabled]="busy()" (click)="preview(d.publishId, i, 'instagram')">{{ 'marketing.publish.review.previewInstagram' | translate }}</button>
                      </div>
                    }
                    @if (frame(); as f) { <iframe class="pw__frame" data-test="preview-frame" [src]="f" title="preview" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups"></iframe> }
                  }
                </div>
              }
            }
            @if (error()) { <p class="nota-error" role="alert" data-test="publish-error">{{ error() | translate }}</p> }
            <div class="pw__actions">
              @if (step() > 1) { <button type="button" [class]="btn()" data-action="wizard-back" [disabled]="busy()" (click)="back()">{{ 'marketing.publish.back' | translate }}</button> }
              @if (step() < 5) { <button type="button" [class]="btnPrimary()" data-action="wizard-next" [disabled]="busy() || !stepValid()" (click)="next()">{{ 'marketing.publish.next' | translate }}</button> }
              @else { <button type="button" [class]="btnPrimary()" data-action="wizard-publish" [disabled]="busy() || !draft()" (click)="publish()">{{ 'marketing.publish.publish' | translate }}</button> }
            </div>
          } @else {
            <div class="pw__group" data-test="publish-progress">
              <ol class="pw__progress">
                @for (name of stepOrder; track name) {
                  <li [attr.data-step]="name" [attr.data-state]="stateOf(name)">{{ 'marketing.publish.progress.' + name | translate }} — {{ 'marketing.publish.state.' + stateOf(name) | translate }}</li>
                }
              </ol>
              @if (publishView()?.status === 'published') {
                <p class="pw__ok" role="status" data-test="publish-done">{{ 'marketing.publish.done' | translate }}</p>
                @if (appliedFeatures()) { <p class="pw__muted" data-test="applied-features">{{ 'marketing.publish.appliedFeatures' | translate }}</p> }
              } @else if (publishView()?.status === 'cancelled') {
                <p class="pw__muted" data-test="publish-cancelled">{{ 'marketing.publish.cancelled' | translate }}</p>
              } @else if (publishView()?.status === 'failed') {
                <p class="nota-error" role="alert" data-test="publish-failed">{{ 'marketing.publish.failedAt' | translate }} «{{ 'marketing.publish.progress.' + (publishView()?.lastError?.step || 'validate') | translate }}»: {{ failureText() }}</p>
                <p class="pw__muted">{{ 'marketing.publish.nothingSpends' | translate }}</p>
                <div class="pw__actions">
                  <button type="button" [class]="btnPrimary()" data-action="publish-retry" [disabled]="busy()" (click)="run()">{{ 'marketing.publish.retry' | translate }}</button>
                  <button type="button" [class]="btn()" data-action="publish-cancel" [disabled]="busy()" (click)="cancel()">{{ 'marketing.publish.cancel' | translate }}</button>
                </div>
              } @else { <p class="pw__muted">{{ 'marketing.publish.running' | translate }}</p> }
              @if (error()) { <p class="nota-error" role="alert" data-test="publish-error">{{ error() | translate }}</p> }
            </div>
          }
        } @else if (loadError()) { <p class="nota-error" role="alert">{{ 'marketing.loadFailed' | translate }}</p> }
      </div>
    </ng-template>

    @if (layout.isMobile()) {
      <nota-mob-sheet [(open)]="visible" [title]="'marketing.publish.title' | translate">
        <ng-container *ngTemplateOutlet="body" />
        <div class="m-actions"><button type="button" class="m-btn" (click)="close()">{{ 'mobile.common.close' | translate }}</button></div>
      </nota-mob-sheet>
    } @else {
      <p-dialog [(visible)]="visible" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
        <nota-dialog-shell [title]="'marketing.publish.title' | translate" [closeLabel]="'mobile.common.close' | translate" (closed)="close()">
          <ng-container *ngTemplateOutlet="body" />
          <ng-container notaDialogFooter>
            <button type="button" notaButton (click)="close()">{{ 'mobile.common.close' | translate }}</button>
          </ng-container>
        </nota-dialog-shell>
      </p-dialog>
    }
  `,
  styles: [`
    .pw { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; min-width: min(560px, 100%); max-width: 100%; }
    .pw > *, .pw__group, .pw__ad, .pw__row { min-width: 0; }
    .pw input, .pw select, .pw textarea { max-width: 100%; box-sizing: border-box; }
    .pw input[type='file'] { width: 100%; }
    .pw__ad, .pw__opt span, .pw__f { overflow-wrap: anywhere; }
    .pw__steps { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; padding: 0; margin: 0; font-size: 12px; }
    .pw__steps li { padding: 2px 8px; border-radius: 999px; background: var(--surface-muted, #f1f5f9); color: var(--text-muted, #6b7280); }
    .pw__steps .pw__on { background: var(--primary, #2563eb); color: #fff; }
    .pw__steps .pw__done { color: var(--success, #15803d); }
    .pw__group { display: grid; gap: 10px; }
    .pw__row { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
    .pw__between { justify-content: space-between; align-items: center; }
    .pw__f { display: flex; flex-direction: column; gap: 4px; font-size: 13px; flex: 1 1 140px; }
    .pw__opt { display: flex; gap: 8px; align-items: flex-start; font-size: 14px; }
    .pw__opt span { display: flex; flex-direction: column; gap: 2px; }
    .pw__off { opacity: .55; }
    .pw__ad { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border, #e5e7eb); border-radius: 8px; }
    .pw__thumb { max-width: 120px; max-height: 120px; object-fit: cover; border-radius: 6px; }
    .pw__muted, small { color: var(--text-muted, #6b7280); font-size: 12px; margin: 0; }
    .pw__warn, .pw__warnText { color: #92400e; font-size: 12px; margin: 0; }
    .pw__ok { color: var(--success, #15803d); margin: 0; }
    .pw__box { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 8px; background: var(--surface-muted, #f1f5f9); font-size: 13px; }
    .pw__box--bad { background: #fee2e2; }
    .pw__chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .pw__x { border: 0; background: transparent; cursor: pointer; font-size: 16px; line-height: 1; }
    .pw__actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .pw__list { margin: 0; padding-inline-start: 18px; display: grid; gap: 2px; font-size: 13px; }
    .pw__progress { margin: 0; padding-inline-start: 18px; display: grid; gap: 2px; font-size: 13px; }
    .pw__progress [data-state='done'] { color: var(--success, #15803d); }
    .pw__progress [data-state='failed'] { color: var(--danger, #b91c1c); }
    .pw__frame { width: 100%; min-height: 420px; border: 1px solid var(--border, #e5e7eb); border-radius: 8px; }
  `],
})
export class MetaPublishWizardComponent {
  readonly campaignId = input.required<string>();
  readonly visible = model(false);
  readonly published = output<void>();

  protected readonly layout = inject(LayoutService);
  private readonly marketing = inject(MarketingService);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly stepOrder = PUBLISH_STEP_ORDER;
  protected readonly maxAds = MAX_ADS;
  protected readonly advantageAges = [18, 19, 20, 21, 22, 23, 24, 25];

  protected readonly options = signal<PublishOptions | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadError = signal(false);
  protected readonly step = signal(1);
  protected readonly phase = signal<'form' | 'publish'>('form');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly warnings = signal<string[]>([]);
  protected readonly draft = signal<PublishView | null>(null);
  protected readonly publishView = signal<PublishView | null>(null);
  protected readonly frame = signal<SafeResourceUrl | null>(null);

  protected readonly goal = signal<PublishGoal>('traffic');
  protected readonly budgetType = signal<'daily' | 'lifetime'>('daily');
  protected readonly amount = signal<number | null>(null);
  protected readonly startTime = signal('');
  protected readonly endTime = signal('');
  protected readonly advantage = signal(true);
  protected readonly ageMin = signal(18);
  protected readonly ageMax = signal(65);
  protected readonly gender = signal<'all' | 'male' | 'female'>('all');
  protected readonly locations = signal<GeoPlace[]>([]);
  protected readonly geoQuery = signal('');
  protected readonly geoResults = signal<GeoPlace[]>([]);
  protected readonly ads = signal<AdDraft[]>([blankAd()]);
  protected readonly pickingIndex = signal(-1);
  protected readonly pickingFor = signal<'image' | 'landing'>('image');
  protected readonly productResults = signal<{ id: string; name: string }[]>([]);
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected readonly input = computed(() => (this.layout.isMobile() ? 'm-input' : 'nota-input'));
  protected readonly btn = computed(() => (this.layout.isMobile() ? 'm-btn' : 'nota-btn'));
  protected readonly btnPrimary = computed(() => (this.layout.isMobile() ? 'm-btn m-btn--primary' : 'nota-btn nota-btn--primary'));

  /** The budget in EGP for the ceiling hint: the same amount for an EGP account, amount × the 7B rate otherwise (null without a rate). */
  protected readonly egp = computed<number | null>(() => {
    const o = this.options(); const a = Number(this.amount());
    if (!o || !(a > 0)) return null;
    if (o.currency === 'EGP') return a;
    return o.rate ? Math.round(a * o.rate * 100) / 100 : null;
  });
  protected readonly overCeiling = computed(() => {
    const o = this.options(); const e = this.egp();
    if (!o || e === null) return false;
    return e > (this.budgetType() === 'daily' ? o.ceiling.dailyEgp : o.ceiling.totalEgp);
  });
  protected readonly appliedFeatures = computed(() => (this.publishView()?.ads ?? []).some((a) => a.appliedFeatures));

  constructor() {
    effect(() => { if (this.visible()) this.open(); });
  }

  private open(): void {
    this.reset();
    this.loading.set(true);
    this.marketing.publishOptions(this.campaignId()).subscribe({
      next: (o) => { this.options.set(o); this.loading.set(false); },
      error: () => { this.loading.set(false); this.loadError.set(true); },
    });
  }

  private reset(): void {
    this.options.set(null); this.loadError.set(false); this.step.set(1); this.phase.set('form'); this.busy.set(false); this.error.set(''); this.warnings.set([]);
    this.draft.set(null); this.publishView.set(null); this.frame.set(null); this.goal.set('traffic'); this.budgetType.set('daily'); this.amount.set(null);
    this.startTime.set(''); this.endTime.set(''); this.advantage.set(true); this.ageMin.set(18); this.ageMax.set(65); this.gender.set('all');
    this.locations.set([]); this.geoQuery.set(''); this.geoResults.set([]); this.ads.set([blankAd()]);
  }

  protected close(): void { this.visible.set(false); }

  // ----- validation per step
  protected readonly stepValid = computed(() => {
    const o = this.options();
    if (!o) return false;
    switch (this.step()) {
      case 1: return this.goal() === 'traffic' || o.salesAllowed;
      case 2: {
        const a = Number(this.amount());
        if (!(a > 0) || this.overCeiling() || (o.currency !== 'EGP' && this.egp() === null)) return false;
        return this.budgetType() === 'daily' || Boolean(this.endTime());
      }
      case 3: {
        if (this.advantage()) return this.ageMin() >= 18 && this.ageMin() <= 25;
        return this.ageMin() >= 18 && this.ageMax() <= 65 && this.ageMin() <= this.ageMax();
      }
      case 4: return this.ads().every((a) => a.primaryText.trim().length > 0 && a.primaryText.length <= 500 && (a.imageKind === 'upload' ? Boolean(a.imageId) && !a.uploading : Boolean(a.productId)) && (a.landingKind === 'campaign' || Boolean(a.landingProductId)));
      default: return true;
    }
  });

  protected back(): void { this.error.set(''); this.step.update((s) => Math.max(1, s - 1)); }

  protected next(): void {
    if (!this.stepValid()) return;
    this.error.set('');
    if (this.step() === 4) { this.createDraft(); return; }
    this.step.update((s) => s + 1);
  }

  // ----- audience
  protected searchGeo(value: string): void {
    this.geoQuery.set(value);
    if (this.timer) clearTimeout(this.timer);
    if (value.trim().length < 2) { this.geoResults.set([]); return; }
    this.timer = setTimeout(() => this.marketing.geoSearch(value.trim()).subscribe({ next: (r) => this.geoResults.set(r.data), error: () => this.geoResults.set([]) }), 300);
  }
  protected addPlace(place: GeoPlace): void {
    if (!this.locations().some((g) => g.key === place.key)) this.locations.update((list) => [...list, place]);
    this.geoResults.set([]); this.geoQuery.set('');
  }
  protected removePlace(key: string): void { this.locations.update((list) => list.filter((g) => g.key !== key)); }

  // ----- ads
  protected addAd(): void { if (this.ads().length < MAX_ADS) this.ads.update((list) => [...list, blankAd()]); }
  protected removeAd(index: number): void { this.ads.update((list) => list.filter((_a, i) => i !== index)); }
  protected patchAd(index: number, patch: Partial<AdDraft>): void { this.ads.update((list) => list.map((a, i) => (i === index ? { ...a, ...patch } : a))); }

  protected pickFile(index: number, event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > MAX_IMAGE_BYTES) {
      this.patchAd(index, { imageId: '', uploading: false, uploadName: '', thumb: '' });
      this.error.set('marketing.publish.errors.IMAGE_INVALID');
      return;
    }
    this.error.set('');
    // One request per image (the file itself, at most 8 MB): the server stages it and the draft only names it by id.
    this.patchAd(index, { imageId: '', uploading: true, uploadName: file.name, thumb: '' });
    const reader = new FileReader();
    reader.onload = () => this.patchAd(index, { thumb: String(reader.result || '') });
    reader.readAsDataURL(file);
    this.marketing.publishUploadImage(this.campaignId(), file).subscribe({
      next: (uploaded) => { this.patchAd(index, { imageId: uploaded.imageId, uploading: false }); },
      error: (response) => { this.patchAd(index, { imageId: '', uploading: false, uploadName: '', thumb: '' }); this.error.set(this.errorKey(response)); },
    });
  }

  protected searchProduct(index: number, purpose: 'image' | 'landing', value: string): void {
    this.pickingIndex.set(index); this.pickingFor.set(purpose);
    if (this.timer) clearTimeout(this.timer);
    if (value.trim().length < 2) { this.productResults.set([]); return; }
    this.timer = setTimeout(() => this.marketing.storeProducts(value.trim()).subscribe({ next: (r) => this.productResults.set(r.data), error: () => this.productResults.set([]) }), 300);
  }
  protected chooseProduct(index: number, product: { id: string; name: string }): void { this.patchAd(index, { productId: product.id, productName: product.name }); this.productResults.set([]); }
  protected chooseLanding(index: number, product: { id: string; name: string }): void { this.patchAd(index, { landingProductId: product.id, landingProductName: product.name }); this.productResults.set([]); }

  // ----- server calls
  private spec(): PublishSpecInput {
    const budget = { type: this.budgetType(), amount: Number(this.amount()), ...(this.startTime() ? { startTime: this.startTime() } : {}), ...(this.endTime() ? { endTime: this.endTime() } : {}) };
    const audience = this.advantage()
      ? { advantage: true, ageMin: this.ageMin(), locations: this.locations() }
      : { advantage: false, ageMin: this.ageMin(), ageMax: this.ageMax(), gender: this.gender(), locations: this.locations() };
    const ads: PublishAdInput[] = this.ads().map((a) => ({
      primaryText: a.primaryText.trim(), headline: a.headline.trim(), description: a.description.trim(), cta: a.cta,
      image: a.imageKind === 'upload' ? { kind: 'upload', imageId: a.imageId } : { kind: 'product', productId: a.productId, index: a.productImageIndex },
      landing: a.landingKind === 'product' ? { kind: 'product', productId: a.landingProductId } : { kind: 'campaign' },
    }));
    return { goal: this.goal(), budget, audience, ads };
  }

  private errorKey(response: { error?: { code?: string } }): string {
    const code = response?.error?.code ?? '';
    return PUBLISH_ERROR_CODES.includes(code) ? `marketing.publish.errors.${code}` : 'marketing.errors.GENERIC';
  }

  private createDraft(): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.publishDraft(this.campaignId(), this.spec()).subscribe({
      next: (d) => { this.busy.set(false); this.draft.set(d); this.warnings.set(d.warnings ?? []); this.step.set(5); },
      error: (response) => { this.busy.set(false); this.error.set(this.errorKey(response)); },
    });
  }

  protected preview(publishId: string, index: number, format: 'feed' | 'instagram'): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(''); this.frame.set(null);
    this.marketing.publishPreview(this.campaignId(), publishId, index, format).subscribe({
      next: (r) => {
        this.busy.set(false);
        // Meta answers with an <iframe src="https://www.facebook.com/...">: only that address is used, in our own sandboxed iframe.
        const src = /src="(https:\/\/www\.facebook\.com\/[^"]+)"/.exec(r.frames[0] ?? '')?.[1]?.replace(/&amp;/g, '&');
        if (src) this.frame.set(this.sanitizer.bypassSecurityTrustResourceUrl(src));
      },
      error: (response) => { this.busy.set(false); this.error.set(this.errorKey(response)); },
    });
  }

  protected publish(): void {
    const d = this.draft();
    if (!d || this.busy()) return;
    this.phase.set('publish');
    this.publishView.set({ ...d, status: 'running' });
    this.run();
  }

  protected run(): void {
    const d = this.draft();
    if (!d || this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.publishView.update((v) => (v ? { ...v, status: 'running' } : v));
    this.marketing.publishRun(this.campaignId(), d.publishId).subscribe({
      next: (view) => { this.busy.set(false); this.publishView.set(view); if (view.status === 'published') this.published.emit(); },
      error: (response) => { this.busy.set(false); this.error.set(this.errorKey(response)); this.publishView.update((v) => (v ? { ...v, status: 'failed' } : v)); },
    });
  }

  protected cancel(): void {
    const d = this.draft();
    if (!d || this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.publishCancel(this.campaignId(), d.publishId).subscribe({
      next: (view) => { this.busy.set(false); this.publishView.set(view); this.published.emit(); },
      error: (response) => { this.busy.set(false); this.error.set(this.errorKey(response)); },
    });
  }

  protected stateOf(name: PublishStepName): string { return this.publishView()?.steps?.[name]?.state ?? 'pending'; }
  /** The failed step's fixed Arabic message from the server (never Meta's text). */
  protected failureText(): string { return this.publishView()?.lastError?.message ?? ''; }
}

import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { BarcodeListComponent } from './barcode-list.component';
import { tick } from './scan-testing';

const base = environment.api_base_url;

@Component({
  standalone: true,
  imports: [FormsModule, BarcodeListComponent],
  template: `<form (submit)="submitted = submitted + 1; $event.preventDefault()">
    <nota-barcode-list [(barcodes)]="barcodes" [canGenerate]="canGenerate" />
    <button type="submit" data-test="submit">save</button>
  </form>`,
})
class HostComponent {
  barcodes: string[] = [];
  canGenerate = true;
  submitted = 0;
}

/** Stage 26: the product form's "الباركود" list. */
describe('BarcodeListComponent (Stage 26)', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const input = () => el().querySelector<HTMLInputElement>('[data-test="barcode-input"]')!;
  const type = (value: string) => { input().value = value; input().dispatchEvent(new Event('input')); fixture.detectChanges(); };
  /** ngModel writes the cleared value back and applies [disabled] in a microtask: wait for it. */
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const enter = () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input().dispatchEvent(event);
    fixture.detectChanges();
    return event;
  };
  const codes = () => Array.from(el().querySelectorAll('[data-barcode]')).map((item) => item.getAttribute('data-barcode'));

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('Enter in the field (a scan ends with Enter) adds the barcode to the list and does NOT submit the form', async () => {
    type('4006381333931');
    const event = enter();
    await settle();
    expect(event.defaultPrevented).toBeTrue();
    expect(host.barcodes).toEqual(['4006381333931']);
    expect(codes()).toEqual(['4006381333931']);
    expect(input().value).toBe('');
    expect(host.submitted).toBe(0);
    // The Save button still submits as usual.
    el().querySelector<HTMLButtonElement>('[data-test="submit"]')!.click();
    expect(host.submitted).toBe(1);
  });

  it('each barcode shows its type: EAN-13, EAN-8, UPC-A, Code 128', () => {
    for (const code of ['4006381333931', '96385074', '036000291452', 'SKU-77']) { type(code); enter(); }
    expect(Array.from(el().querySelectorAll('[data-test="barcode-type"]')).map((chip) => chip.textContent!.trim())).toEqual(['EAN-13', 'EAN-8', 'UPC-A', 'Code 128']);
  });

  it('an Arabic-layout scan and Arabic-Indic digits are normalised before they are added', () => {
    type('٩٦٣٨٥٠٧٤'); enter();
    type('‏4006381333931​'); enter();
    expect(host.barcodes).toEqual(['96385074', '4006381333931']);
  });

  it('a wrong check digit, a bad character, a short code and a repeat are refused with a message and not added', () => {
    type('4006381333932'); enter();
    expect(host.barcodes).toEqual([]);
    expect(el().querySelector('[data-test="barcode-error"]')!.textContent).toContain('barcodes.errors.checkDigit');
    type('AB CD'); enter();
    expect(el().querySelector('[data-test="barcode-error"]')!.textContent).toContain('barcodes.errors.chars');
    type('abc'); enter();
    expect(el().querySelector('[data-test="barcode-error"]')!.textContent).toContain('barcodes.errors.length');
    type('SKU-1'); enter();
    type('SKU-1'); enter();
    expect(host.barcodes).toEqual(['SKU-1']);
    expect(el().querySelector('[data-test="barcode-error"]')!.textContent).toContain('barcodes.duplicate');
    expect(host.submitted).toBe(0);
  });

  it('at most 5 barcodes: the field is disabled after the fifth', async () => {
    for (const code of ['AAAA1', 'AAAA2', 'AAAA3', 'AAAA4', 'AAAA5']) { type(code); enter(); }
    await settle();
    expect(host.barcodes.length).toBe(5);
    expect(input().disabled).toBeTrue();
    expect(el().querySelector<HTMLButtonElement>('[data-test="barcode-generate"]')!.disabled).toBeTrue();
  });

  it('remove takes a barcode off the list', () => {
    type('AAAA1'); enter(); type('AAAA2'); enter();
    el().querySelector<HTMLButtonElement>('[data-barcode="AAAA1"] [data-test="barcode-remove"]')!.click();
    fixture.detectChanges();
    expect(host.barcodes).toEqual(['AAAA2']);
  });

  it('"ولّد باركود" asks the server for an in-store EAN-13 and adds it; only for a user who can edit products', async () => {
    el().querySelector<HTMLButtonElement>('[data-test="barcode-generate"]')!.click();
    http.expectOne(`${base}products/barcodes/generate`).flush({ barcode: '2900000000018', type: 'EAN-13' });
    await tick();
    fixture.detectChanges();
    expect(host.barcodes).toEqual(['2900000000018']);
    expect(codes()).toEqual(['2900000000018']);

    host.canGenerate = false;
    fixture.componentRef.changeDetectorRef.detectChanges();
    fixture.detectChanges();
    expect(el().querySelector('[data-test="barcode-generate"]')).toBeNull();
  });

  it('a failed generate shows the server message and adds nothing', async () => {
    el().querySelector<HTMLButtonElement>('[data-test="barcode-generate"]')!.click();
    http.expectOne(`${base}products/barcodes/generate`).flush({ message: 'خلصت الأرقام' }, { status: 409, statusText: 'Conflict' });
    await tick();
    fixture.detectChanges();
    expect(host.barcodes).toEqual([]);
    expect(el().querySelector('[data-test="barcode-error"]')!.textContent).toContain('خلصت الأرقام');
  });
});

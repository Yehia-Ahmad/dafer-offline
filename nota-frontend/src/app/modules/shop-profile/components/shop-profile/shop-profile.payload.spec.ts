import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { ShopProfileComponent } from './shop-profile.component';

/** Stage 11: /shop-profile — GET and PUT shop-profile, exact body. */
describe('ShopProfileComponent payloads (Stage 11)', () => {
  const url = `${environment.api_base_url}shop-profile`;
  let http: HttpTestingController;
  let component: any;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ShopProfileComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ShopProfileComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne((r) => r.url === url && r.method === 'GET').flush({
      name: 'النور', address: 'المنصورة', phones: ['0100'], logo: null, taxNumber: '', commercialRegister: '45', invoiceFooter: 'شكرا',
    });
  });

  afterEach(() => http.verify());

  it('save: PUT shop-profile with trimmed fields, empty phones dropped, logo kept', () => {
    component.form.patchValue({ name: '  النور للأدوات ', address: ' ١٢ شارع الجيش ', taxNumber: ' 123 ' });
    component.addPhone('  ');
    component.addPhone(' 050 123 ');
    component.logo.set('data:image/png;base64,AAAA');
    component.save();
    const req = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({
      name: 'النور للأدوات', address: '١٢ شارع الجيش', phones: ['0100', '050 123'], logo: 'data:image/png;base64,AAAA',
      taxNumber: '123', commercialRegister: '45', invoiceFooter: 'شكرا', autoLockMinutes: 10,
    }));
    req.flush({ name: 'النور للأدوات', address: '', phones: [], logo: null, taxNumber: '', commercialRegister: '', invoiceFooter: '' });
    expect(component.outcome()).toEqual({ kind: 'saved' });
  });

  it('no name: nothing is sent', () => {
    component.form.patchValue({ name: '' });
    component.save();
    http.expectNone((r) => r.method === 'PUT');
  });
});

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { DeliveryZonesComponent } from './delivery-zones.component';

/** Online Stage 3: /website/delivery-zones: list, add/edit dialog bodies, delete only when unused (else deactivate). */
describe('DeliveryZonesComponent (Online Stage 3)', () => {
  const url = `${environment.api_base_url}website/delivery-zones`;
  let http: HttpTestingController;
  let component: any;
  let fixture: any;

  const zones = [
    { id: 'z1', name: 'القاهرة', fee: 30, estimatedTime: 'خلال 24 ساعة', isActive: true, sortOrder: 1, used: true },
    { id: 'z2', name: 'الجيزة', fee: 45.5, estimatedTime: '', isActive: true, sortOrder: 2, used: false },
    { id: 'z3', name: 'الإسكندرية', fee: 60, estimatedTime: 'يومين', isActive: false, sortOrder: 3, used: true },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DeliveryZonesComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(DeliveryZonesComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne((r) => r.url === url && r.method === 'GET').flush({ data: zones });
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  const rows = (): HTMLElement[] => Array.from(fixture.nativeElement.querySelectorAll('[data-test="zone-row"]'));
  const actionsOf = (row: HTMLElement) => Array.from(row.querySelectorAll('[data-action]')).map((el) => (el as HTMLElement).dataset['action']);

  it('lists the zones; a zone an order used offers deactivate (never delete); an unused one offers delete', () => {
    expect(rows().length).toBe(3);
    expect(actionsOf(rows()[0])).toEqual(['edit-zone', 'deactivate-zone']);
    expect(actionsOf(rows()[1])).toEqual(['edit-zone', 'delete-zone']);
    expect(actionsOf(rows()[2])).toEqual(['edit-zone', 'activate-zone'], 'an inactive used zone can be activated again, still not deleted');
  });

  it('add: POST with the typed values, then the list reloads', () => {
    component.openAdd();
    expect(component.dialogOpen()).toBeTrue();
    expect(component.form.controls.sortOrder.value).toBe('4');
    component.form.patchValue({ name: '  المنصورة ', fee: '25.5', estimatedTime: ' 3 أيام ', isActive: true, sortOrder: '7' });
    component.save();
    const req = http.expectOne((r) => r.url === url && r.method === 'POST');
    expect(req.request.body).toEqual({ name: 'المنصورة', fee: 25.5, estimatedTime: '3 أيام', isActive: true, sortOrder: 7 });
    req.flush({ id: 'z4' });
    http.expectOne((r) => r.url === url && r.method === 'GET').flush({ data: zones });
    expect(component.dialogOpen()).toBeFalse();
  });

  it('edit: PUT on the zone id with the changed values', () => {
    component.openEdit(zones[1]);
    expect(component.form.getRawValue()).toEqual({ name: 'الجيزة', fee: '45.5', estimatedTime: '', isActive: true, sortOrder: '2' });
    component.form.patchValue({ fee: '50', isActive: false });
    component.save();
    const req = http.expectOne((r) => r.url === `${url}/z2` && r.method === 'PUT');
    expect(req.request.body).toEqual({ name: 'الجيزة', fee: 50, estimatedTime: '', isActive: false, sortOrder: 2 });
    req.flush({});
    http.expectOne((r) => r.url === url && r.method === 'GET').flush({ data: zones });
  });

  it('validation: a name and a fee (zero or more, 2 decimals) are required; nothing is sent otherwise', () => {
    component.openAdd();
    component.save();
    for (const fee of ['', '-1', 'abc', '1.234']) {
      component.form.patchValue({ name: 'ز', fee });
      component.save();
    }
    component.form.patchValue({ name: '', fee: '10' });
    component.save();
    http.expectNone((r) => r.method === 'POST');
    component.form.patchValue({ name: 'ز', fee: '0' });
    component.save();
    http.expectOne((r) => r.method === 'POST').flush({});
    http.expectOne((r) => r.method === 'GET').flush({ data: [] });
  });

  it('deactivate and activate send isActive only', () => {
    component.deactivate(zones[0]);
    const off = http.expectOne((r) => r.url === `${url}/z1` && r.method === 'PUT');
    expect(off.request.body).toEqual({ isActive: false });
    off.flush({});
    http.expectOne((r) => r.method === 'GET').flush({ data: zones });
    component.activate(zones[2]);
    const on = http.expectOne((r) => r.url === `${url}/z3` && r.method === 'PUT');
    expect(on.request.body).toEqual({ isActive: true });
    on.flush({});
    http.expectOne((r) => r.method === 'GET').flush({ data: zones });
  });

  it('delete asks first, then DELETE on the id; a refusal shows the server message and reloads', () => {
    component.askDelete(zones[1]);
    expect(component.deleting()).toEqual(zones[1]);
    component.cancelDelete();
    expect(component.deleting()).toBeNull();
    http.expectNone((r) => r.method === 'DELETE');
    component.askDelete(zones[1]);
    component.confirmDelete();
    http.expectOne((r) => r.url === `${url}/z2` && r.method === 'DELETE').flush({ message: 'المنطقة مستخدمة في طلبات. تقدر توقفها بس' }, { status: 409, statusText: 'Conflict' });
    http.expectOne((r) => r.method === 'GET').flush({ data: zones });
    expect(component.errorMessage()).toBe('المنطقة مستخدمة في طلبات. تقدر توقفها بس');
    component.askDelete(zones[1]);
    component.confirmDelete();
    http.expectOne((r) => r.method === 'DELETE').flush(null, { status: 204, statusText: 'No Content' });
    http.expectOne((r) => r.method === 'GET').flush({ data: [zones[0], zones[2]] });
    fixture.detectChanges();
    expect(rows().length).toBe(2);
  });
});

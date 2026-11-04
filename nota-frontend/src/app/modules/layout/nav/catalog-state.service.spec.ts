import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CateoryService } from '../../category/services/cateory.service';
import { CatalogStateService } from './catalog-state.service';

describe('CatalogStateService (Stage 9 shared category list)', () => {
  let service: CatalogStateService;
  let categories: jasmine.SpyObj<CateoryService>;

  beforeEach(() => {
    categories = jasmine.createSpyObj<CateoryService>('CateoryService', ['getCategories', 'getProducts']);
    TestBed.configureTestingModule({ providers: [{ provide: CateoryService, useValue: categories }] });
    service = TestBed.inject(CatalogStateService);
  });

  it('loads categories, then checks for products in the first one (same requests as the old sidebar)', () => {
    categories.getCategories.and.returnValue(of([{ _id: 'c1', name: 'لمبات' }, { _id: 'c2', name: 'شواحن' }]) as any);
    categories.getProducts.and.returnValue(of({ data: [{ _id: 'p1' }] }) as any);
    service.refresh();
    expect(service.categories().map((c) => c.route)).toEqual(['/categories/c1', '/categories/c2']);
    expect(categories.getProducts).toHaveBeenCalledOnceWith('c1', { categoryId: 'c1', limit: 1 });
    expect(service.hasProducts()).toBeTrue();
  });

  it('every refresh re-checks the product flag; no categories → false', () => {
    categories.getCategories.and.returnValue(of([{ _id: 'c1', name: 'لمبات' }]) as any);
    categories.getProducts.and.returnValue(of([{ _id: 'p1' }]) as any);
    service.refresh();
    service.refresh();
    expect(categories.getProducts).toHaveBeenCalledTimes(2);

    categories.getCategories.and.returnValue(of({ data: [] }) as any);
    service.refresh();
    expect(service.hasProducts()).toBeFalse();
  });

  it('reports a categories error to the caller', () => {
    categories.getCategories.and.returnValue(throwError(() => new Error('x')));
    const onError = jasmine.createSpy('onError');
    service.refresh(onError);
    expect(onError).toHaveBeenCalled();
    expect(categories.getProducts).not.toHaveBeenCalled();
  });
});

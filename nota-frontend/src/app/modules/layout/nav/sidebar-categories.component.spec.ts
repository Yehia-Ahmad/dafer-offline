import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';

import { SidebarCategoriesComponent } from './sidebar-categories.component';
import { SidebarStateService } from './sidebar-state.service';
import { CateoryService } from '../../category/services/cateory.service';
import { ProductsService } from '../../products/services/products.service';

// Stage 8: every feature of the old custom-sidenav category block must stay reachable from the new sidebar.
describe('SidebarCategoriesComponent (old custom-sidenav features)', () => {
  let fixture: ComponentFixture<SidebarCategoriesComponent>;
  let component: SidebarCategoriesComponent;
  let categories: jasmine.SpyObj<CateoryService>;
  let products: jasmine.SpyObj<ProductsService>;
  const collapsed = signal(false);
  const sidebarState = { collapsed, setCollapsed: jasmine.createSpy('setCollapsed').and.callFake((v: boolean) => collapsed.set(v)) };

  const el = () => fixture.nativeElement as HTMLElement;
  const click = (selector: string) => {
    const button = el().querySelector<HTMLElement>(selector);
    expect(button).withContext(selector).not.toBeNull();
    button!.click();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    collapsed.set(false);
    categories = jasmine.createSpyObj<CateoryService>('CateoryService', [
      'getCategories', 'getCategoryById', 'createCategory', 'updateCategory', 'deleteCategory',
      'exportCategories', 'importCategories', 'getProducts',
    ]);
    categories.getCategories.and.returnValue(of([{ _id: 'c1', name: 'لمبات', specifications: [{ title: 'القدرة' }] }]) as any);
    categories.getProducts.and.returnValue(of([{ _id: 'p1' }]) as any);
    categories.getCategoryById.and.returnValue(of({ _id: 'c1', name: 'لمبات', specifications: [{ title: 'القدرة' }] }) as any);
    categories.createCategory.and.returnValue(of({}) as any);
    categories.updateCategory.and.returnValue(of({}) as any);
    categories.deleteCategory.and.returnValue(of({}) as any);
    categories.exportCategories.and.returnValue(of(new Blob()));
    categories.importCategories.and.returnValue(of({ success: true, importedCount: 1, skippedCount: 0, errors: [] } as any));
    products = jasmine.createSpyObj<ProductsService>('ProductsService', ['exportProductsExcel']);
    products.exportProductsExcel.and.returnValue(of(new Blob()));

    await TestBed.configureTestingModule({
      imports: [SidebarCategoriesComponent, TranslateModule.forRoot()],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        { provide: CateoryService, useValue: categories },
        { provide: ProductsService, useValue: products },
        { provide: SidebarStateService, useValue: sidebarState },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SidebarCategoriesComponent);
    component = fixture.componentInstance;
    spyOn(component as any, 'downloadBlob'); // no real file downloads in the test browser
    fixture.detectChanges();
    click('button.nota-nav__link'); // expand "الأصناف والفئات"
  });

  it('loads the category list and links each one to /categories/:id', () => {
    expect(categories.getCategories).toHaveBeenCalled();
    const link = el().querySelector<HTMLAnchorElement>('.nota-cat__link');
    expect(link?.textContent?.trim()).toBe('لمبات');
    expect(link?.getAttribute('href')).toBe('/categories/c1');
  });

  it('collapsed rail: the item expands the sidebar first', () => {
    click('button.nota-nav__link'); // close
    collapsed.set(true);
    click('button.nota-nav__link');
    expect(sidebarState.setCollapsed).toHaveBeenCalledWith(false);
  });

  it('add category: opens the dialog and saves through createCategory', () => {
    click('[data-action=add-category]');
    expect(component.visible).toBeTrue();
    component.addCategory.patchValue({ name: 'جديدة' });
    component.addSpecification();
    component.specifications.at(0).setValue('اللون');
    component.addNewCategory();
    expect(categories.createCategory).toHaveBeenCalledWith({ name: 'جديدة', specifications: [{ title: 'اللون' }] } as any);
  });

  it('edit category: prefills from getCategoryById and saves through updateCategory', () => {
    click('.nota-cat__row button[title="nav.categories.edit"]');
    expect(categories.getCategoryById).toHaveBeenCalledWith('c1');
    expect(component.addCategory.value.name).toBe('لمبات');
    expect(component.specifications.value).toEqual(['القدرة']);
    component.addNewCategory();
    expect(categories.updateCategory).toHaveBeenCalledWith('c1', jasmine.objectContaining({ name: 'لمبات' }));
  });

  it('delete category: asks, then calls deleteCategory', () => {
    click('.nota-cat__row button[title="nav.categories.delete"]');
    expect(component.deleteCategoryVisible).toBeTrue();
    expect(component.categoryToDelete.id).toBe('c1');
    component.confirmDeleteCategory();
    expect(categories.deleteCategory).toHaveBeenCalledWith('c1');
  });

  it('export categories (Excel)', () => {
    click('[data-action=export-categories]');
    expect(categories.exportCategories).toHaveBeenCalled();
    expect((component as any).downloadBlob).toHaveBeenCalledWith(jasmine.any(Blob), 'categories-export.xlsx');
  });

  it('import categories (Excel): the button opens the file picker and the file goes to importCategories', () => {
    const input = el().querySelector<HTMLInputElement>('input[type=file]')!;
    const picker = spyOn(input, 'click');
    click('[data-action=import-categories]');
    expect(picker).toHaveBeenCalled();

    const file = new File(['x'], 'categories.xlsx');
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    expect(categories.importCategories).toHaveBeenCalledWith(file);
    expect(component.importResultVisible()).toBeTrue();
  });

  it('download the category import template', () => {
    const template = spyOn(component, 'downloadCategoriesTemplate').and.resolveTo();
    click('[data-action=category-template]');
    expect(template).toHaveBeenCalled();
  });

  it('product-exists check shows "export products", which calls exportProductsExcel', () => {
    expect(categories.getProducts).toHaveBeenCalledWith('c1', { categoryId: 'c1', limit: 1 });
    expect(component.hasProducts()).toBeTrue();
    click('[data-action=export-products]');
    expect(products.exportProductsExcel).toHaveBeenCalled();
  });
});

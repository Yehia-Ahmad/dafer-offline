import { ChangeDetectorRef, Component, ViewChild } from '@angular/core';
import { SideNavComponent } from "../../../layout/components/side-nav/side-nav.component";
import { FormBuilder, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { CommonModule, Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { CateoryService } from '../../services/cateory.service';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { WarnComponent } from "../../../assets/warn/warn.component";
import { TranslatePipe } from '@ngx-translate/core';
import { ThemeService } from '../../../shared/services/theme.service';
import { ErrorIconComponent } from "../../../assets/error/error-icon.component";
import { DatePickerModule } from 'primeng/datepicker';
import { format as formatDate } from 'date-fns';
import { SeoFormComponent } from '../../../seo/components/seo-form/seo-form.component';
import { SeoEditorForm, SeoFormContext } from '../../../seo/models/seo.models';
import { buildSeoFormValue, normalizeSeoExtensionPayload } from '../../../seo/utilities/seo.utils';
import { isWebsiteEnabled } from '../../../../core/runtime/app-features';

@Component({
  selector: 'app-product-edit',
  imports: [CommonModule, FormsModule, ReactiveFormsModule, DialogModule, ButtonModule, SideNavComponent, WarnComponent, TranslatePipe, ErrorIconComponent, DatePickerModule, SeoFormComponent],
  templateUrl: './product-edit.component.html',
  styleUrl: './product-edit.component.scss'
})
export class ProductEditComponent {
  @ViewChild(SeoFormComponent) private seoFormComponent?: SeoFormComponent;
  isLoading: boolean = false;
  productId: any;
  product: any = {};
  newInventory: number | string | null = null;
  inventoryCount: any;
  wholesalePrice: any;
  retailPrice: any;
  soldItemCount: any;
  loading: boolean = false;
  deleteVisible: boolean = false;
  syncVisible: boolean = false;
  syncLoading: boolean = false;
  syncDateFrom: Date | null = null;
  syncDateTo: Date | null = null;
  isDarkMode$;
  imagePreview: string | ArrayBuffer | null = null;
  productDetails: { title: string; value: string }[] = [];
  productSeoForm: SeoEditorForm;
  productSeoContext: SeoFormContext = { entityType: 'product' };
  readonly websiteEnabled = isWebsiteEnabled();
  errorVisible = false;
  errorMessage = '';

  constructor(private _themeService: ThemeService, private cdr: ChangeDetectorRef, private _router: Router, private _cateoryService: CateoryService, private _activatedRoute: ActivatedRoute, private location: Location, private fb: FormBuilder) {
    this.isDarkMode$ = this._themeService.isDarkMode$;
    this.productId = this._activatedRoute.snapshot.params['id'];
    this.productSeoForm = buildSeoFormValue(this.fb, 'product', {}, this.productSeoContext);
  }

  ngOnInit() {
    setTimeout(() => {
      this.getProductById();
    }, 100)
  }

  getProductById() {
    this.loading = true;
    this._cateoryService.getProductById(this.productId).subscribe({
      next: (res: any) => {
        this.loading = false;
        this.product = res;
        this.productDetails = this.buildProductDetails(this.product);
        this.newInventory = null;
        this.refreshProductSeoForm();
        this.cdr.detectChanges();
      }, error: (err: any) => {
        this.loading = false;
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    })
  }

  deleteProduct() {
    this.loading = true;
    this._cateoryService.deleteProduct(this.productId).subscribe({
      next: (res: any) => {
        this.loading = false;
        this.cdr.detectChanges();
        this.location.back();
      }, error: (err: any) => {
        this.loading = false;
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    }) 
  }

  updateProduct() {
    this.loading = true;
    const currentInventoryCount = this.toNumber(this.product.inventoryCount);
    const newInventoryCount = Math.max(0, this.toNumber(this.newInventory));

    let payload = {
      name: this.product.name,
      code: this.product.code,
      inventoryCount: currentInventoryCount,
      newInventory: newInventoryCount,
      wholesalePrice: this.product.wholesalePrice,
      purchasePrice: this.product.purchasePrice,
      retailPrice: this.product.retailPrice,
      discountPercentage: this.normalizePercentage(this.product.discountPercentage),
      soldItemCount: this.product.soldItemCount,
      image: this.product.image,
      editProduct: newInventoryCount === 0,
      specifications: this.normalizeProductDetails(this.productDetails),
    };
    // Offline the SEO fields are hidden; leaving them out keeps stored SEO data untouched.
    if (this.websiteEnabled) {
      Object.assign(payload, normalizeSeoExtensionPayload(this.productSeoForm));
    }
    this._cateoryService.updateProduct(this.productId, payload).subscribe({
      next: (res: any) => {
        this.loading = false;
        this.cdr.detectChanges();
        this.location.back();
      }, error: (err: any) => {
        this.loading = false;
        this.applySeoDuplicateError(err);
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    })
  }


  showDeleteDialog() {
    this.deleteVisible = true;
  }

  closeDialog() {
    this.deleteVisible = false;
  }

  showSyncDialog() {
    this.syncVisible = true;
  }

  closeSyncDialog() {
    if (this.syncLoading) return;
    this.syncVisible = false;
    this.syncDateFrom = null;
    this.syncDateTo = null;
  }

  syncPurchasePriceToInvoices() {
    this.syncLoading = true;

    const payload = {
      ...(this.syncDateFrom ? { dateFrom: formatDate(this.syncDateFrom, 'yyyy-MM-dd') } : {}),
      ...(this.syncDateTo ? { dateTo: formatDate(this.syncDateTo, 'yyyy-MM-dd') } : {})
    };

    this._cateoryService.syncProductPurchasePrice(this.productId, payload).subscribe({
      next: () => {
        this.syncLoading = false;
        this.closeSyncDialog();
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.syncLoading = false;
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    });
  }
  
  onBasicUploadAuto(event: any) {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64String = reader.result as string;
        this.imagePreview = base64String;
        // this.product.image = file;
        this.product.image = base64String;
        this.refreshProductSeoContext();
        this.cdr.detectChanges();
      };
      reader.readAsDataURL(file);
    }
  }

  isOutOfStock(inventoryCount: unknown): boolean {
    const parsedValue = Number(inventoryCount);
    return Number.isFinite(parsedValue) && parsedValue === 0;
  }

  private toNumber(value: unknown): number {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : 0;
  }

  private normalizePercentage(value: unknown): number {
    return Math.min(100, Math.max(0, this.toNumber(value)));
  }

  private buildProductDetails(product: any): { title: string; value: string }[] {
    const existingDetails = this.normalizeProductDetails(product?.specifications || product?.details || []);
    const existingValueByTitle = new Map(
      existingDetails.map((detail) => [detail.title, detail.value])
    );

    const categorySpecifications = this.extractCategorySpecifications(product?.category);
    if (!categorySpecifications.length) {
      return existingDetails;
    }

    return categorySpecifications.map((specification) => ({
      title: specification.title,
      value: existingValueByTitle.get(specification.title) || ''
    }));
  }

  private extractCategorySpecifications(category: any): { title: string }[] {
    const specifications = category?.specifications || category?.specification || category?.specs || [];
    if (!Array.isArray(specifications)) return [];

    return specifications
      .map((specification: any) => {
        if (typeof specification === 'string') return { title: specification };
        return { title: specification?.title || specification?.name || specification?.rowName || '' };
      })
      .map((specification: { title: string }) => ({
        title: String(specification.title || '').trim()
      }))
      .filter((specification: { title: string }) => Boolean(specification.title));
  }

  private normalizeProductDetails(details: any[]): { title: string; value: string }[] {
    if (!Array.isArray(details)) return [];

    return details
      .map((detail: any) => ({
        title: String(detail?.title || '').trim(),
        value: String(detail?.value || '').trim()
      }))
      .filter((detail: { title: string }) => Boolean(detail.title));
  }

  refreshProductSeoContext(): void {
    this.productSeoContext = {
      entityType: 'product',
      entityId: String(this.productId || ''),
      legacyName: String(this.product?.name || '').trim(),
      categoryName: String(this.product?.category?.name || this.product?.categoryName || '').trim(),
      code: String(this.product?.code || '').trim(),
      image: String(this.product?.image || ''),
      price: this.product?.retailPrice,
      specifications: this.normalizeProductDetails(this.productDetails)
    };
  }

  private refreshProductSeoForm(): void {
    this.refreshProductSeoContext();
    this.productSeoForm = buildSeoFormValue(
      this.fb,
      'product',
      {
        translations: this.product?.translations,
        seo: this.product?.seo
      },
      this.productSeoContext
    );
  }

  private applySeoDuplicateError(err: unknown): void {
    this.seoFormComponent?.applyDuplicateSlugError(err);
  }
}

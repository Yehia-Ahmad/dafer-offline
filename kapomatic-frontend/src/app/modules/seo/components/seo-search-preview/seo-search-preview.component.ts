import { CommonModule, CurrencyPipe } from '@angular/common';
import { Component, Input } from '@angular/core';
import { SeoPreviewDevice, SeoSearchPreviewData } from '../../models/seo.models';

@Component({
  selector: 'app-seo-search-preview',
  standalone: true,
  imports: [CommonModule, CurrencyPipe],
  templateUrl: './seo-search-preview.component.html',
  styleUrl: './seo-search-preview.component.scss'
})
export class SeoSearchPreviewComponent {
  @Input({ required: true }) preview!: SeoSearchPreviewData;
  @Input() device: SeoPreviewDevice = 'desktop';
}

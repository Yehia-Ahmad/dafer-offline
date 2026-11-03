import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

import { CateoryService } from './cateory.service';

describe('CateoryService', () => {
  let service: CateoryService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(CateoryService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});

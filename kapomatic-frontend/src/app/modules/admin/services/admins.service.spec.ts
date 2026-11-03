import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

import { AdminsService } from './admins.service';

describe('Admins', () => {
  let service: AdminsService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(AdminsService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});

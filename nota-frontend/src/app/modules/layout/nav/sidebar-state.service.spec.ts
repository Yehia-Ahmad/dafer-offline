import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { SIDEBAR_COLLAPSED_KEY, SidebarStateService } from './sidebar-state.service';

describe('SidebarStateService', () => {
  let width: number;

  function create(): SidebarStateService {
    spyOnProperty(window, 'innerWidth').and.callFake(() => width);
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    return TestBed.inject(SidebarStateService);
  }

  beforeEach(() => localStorage.removeItem(SIDEBAR_COLLAPSED_KEY));
  afterEach(() => localStorage.removeItem(SIDEBAR_COLLAPSED_KEY));

  it('wide window: expanded by default, collapse is remembered per device', () => {
    width = 1440;
    const state = create();
    expect(state.mode()).toBe('full');
    state.toggleCollapsed();
    expect(state.mode()).toBe('rail');
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('true');
  });

  it('1024px and narrower start as the rail', () => {
    width = 1024;
    expect(create().mode()).toBe('rail');
  });

  it('below 768px it is a drawer that opens and closes', () => {
    width = 390;
    const state = create();
    expect(state.mode()).toBe('drawer');
    expect(state.collapsed()).toBeFalse();
    state.openDrawer();
    expect(state.drawerOpen()).toBeTrue();
    state.closeDrawer();
    expect(state.drawerOpen()).toBeFalse();
  });
});

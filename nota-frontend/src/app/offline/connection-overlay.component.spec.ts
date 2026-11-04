import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DesktopConnectionState, KapomaticDesktopBridge } from '../core/runtime/runtime-config';
import { ConnectionOverlayComponent } from './connection-overlay.component';

describe('ConnectionOverlayComponent', () => {
  let emit: (state: DesktopConnectionState) => void;
  let bridge: jasmine.SpyObj<Required<KapomaticDesktopBridge>>;
  let fixture: ComponentFixture<ConnectionOverlayComponent>;
  const original = window.kapomaticDesktop;

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const buttons = () => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
  const update = async (state: DesktopConnectionState) => {
    emit(state);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    bridge = jasmine.createSpyObj('bridge', [
      'getRuntimeConfig',
      'getConnection',
      'onConnection',
      'retryConnection',
      'changeServerAddress',
    ]);
    bridge.onConnection.and.callFake((callback) => {
      emit = callback;
      return () => undefined;
    });
    bridge.getConnection.and.resolveTo({ connected: true });
    bridge.retryConnection.and.resolveTo({ connected: true });
    window.kapomaticDesktop = bridge;

    await TestBed.configureTestingModule({
      imports: [ConnectionOverlayComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    fixture = TestBed.createComponent(ConnectionOverlayComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    window.kapomaticDesktop = original;
  });

  it('stays hidden while connected', () => {
    expect(text().trim()).toBe('');
  });

  it('shows the Arabic message, retry and change-address on a client PC', async () => {
    await update({ connected: false, reason: 'unreachable', role: 'client', address: '192.168.1.10:5055' });
    expect(text()).toContain('لا يوجد اتصال بالجهاز الرئيسي');
    expect(text()).toContain('192.168.1.10:5055');
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(['إعادة المحاولة', 'تغيير عنوان الجهاز الرئيسي']);

    buttons()[1].click();
    expect(bridge.changeServerAddress).toHaveBeenCalled();
  });

  it('retry asks the desktop app and hides when the connection is back', async () => {
    await update({ connected: false, reason: 'unreachable', role: 'client' });
    buttons()[0].click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(bridge.retryConnection).toHaveBeenCalled();
    expect(text().trim()).toBe('');
  });

  it('explains a changed secret', async () => {
    await update({ connected: false, reason: 'unauthorized', role: 'client' });
    expect(text()).toContain('كلمة سر الشبكة');
  });

  it('on the main PC a restarting server shows a spinner and no buttons', async () => {
    await update({ connected: false, reason: 'server-restarting', role: 'main' });
    expect(text()).toContain('جاري إعادة تشغيل الخادم');
    expect(buttons().length).toBe(0);
  });

  it('on the main PC the daily backup pause shows a short wait and no buttons', async () => {
    await update({ connected: false, reason: 'server-maintenance', role: 'main' });
    expect(text()).toContain('جاري حفظ النسخة الاحتياطية اليومية');
    expect(buttons().length).toBe(0);
  });
});

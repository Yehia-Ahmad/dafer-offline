import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { AuthService } from '../../../core/auth/auth.service';
import { signInAs } from '../../../core/auth/testing/sign-in';
import { DeviceService } from '../../../core/device/device.service';
import { DeviceNameDialogComponent } from './device-name-dialog.component';

describe('DeviceNameDialogComponent (decision D)', () => {
  const setup = () => {
    localStorage.removeItem('nota.deviceName');
    TestBed.configureTestingModule({
      imports: [DeviceNameDialogComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()],
    });
    const device = TestBed.inject(DeviceService);
    device.name.set('');
    device.skipped.set(false);
    device.dialogOpen.set(false);
    const fixture = TestBed.createComponent(DeviceNameDialogComponent);
    fixture.detectChanges();
    return { device, fixture };
  };
  afterEach(() => {
    localStorage.removeItem('nota.deviceName');
  });

  it('not asked while nobody is signed in', async () => {
    const { device, fixture } = setup();
    TestBed.inject(AuthService).clear();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(device.dialogOpen()).toBeFalse();
  });

  it('asked once after sign in when the device has no name; saving stores it and it is never asked again', async () => {
    const { device, fixture } = setup();
    signInAs('cashier');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(device.dialogOpen()).toBeTrue();
    fixture.componentInstance.value.set('   ');
    fixture.componentInstance.save();
    expect(fixture.componentInstance.error()).toBe('auth.device.required');
    expect(device.dialogOpen()).toBeTrue();
    fixture.componentInstance.value.set('كاشير 1');
    fixture.componentInstance.save();
    expect(device.name()).toBe('كاشير 1');
    expect(device.dialogOpen()).toBeFalse();
    expect(localStorage.getItem('nota.deviceName')).toBe('كاشير 1');
    signInAs('manager');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(device.dialogOpen()).toBeFalse();
  });

  it('closing the first question without a name does not ask again until the page is reloaded; the name can be changed later', async () => {
    const { device, fixture } = setup();
    signInAs('cashier');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.close();
    expect(device.dialogOpen()).toBeFalse();
    expect(device.skipped()).toBeTrue();
    signInAs('manager');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(device.dialogOpen()).toBeFalse();
    // later, from the sidebar
    device.setName('كاشير 1');
    device.dialogOpen.set(true);
    fixture.componentInstance.start();
    expect(fixture.componentInstance.value()).toBe('كاشير 1');
    fixture.componentInstance.value.set('كاشير 2');
    fixture.componentInstance.save();
    expect(device.name()).toBe('كاشير 2');
  });
});

import { TestBed } from '@angular/core/testing';
import { DEVICE_ID_PATTERN, DEVICE_NAME_MAX, DeviceService } from './device.service';

describe('DeviceService (decision D)', () => {
  beforeEach(() => {
    localStorage.removeItem('nota.deviceId');
    localStorage.removeItem('nota.deviceName');
    TestBed.resetTestingModule();
  });
  afterEach(() => {
    localStorage.removeItem('nota.deviceId');
    localStorage.removeItem('nota.deviceName');
  });

  it('generates a random id that matches the backend pattern, stores it once and keeps it', () => {
    const first = TestBed.inject(DeviceService).deviceId;
    expect(DEVICE_ID_PATTERN.test(first)).toBeTrue();
    expect(localStorage.getItem('nota.deviceId')).toBe(first);
    TestBed.resetTestingModule();
    expect(TestBed.inject(DeviceService).deviceId).toBe(first);
  });

  it('a stored id that does not match the pattern is replaced', () => {
    localStorage.setItem('nota.deviceId', 'bad id!');
    const id = TestBed.inject(DeviceService).deviceId;
    expect(id).not.toBe('bad id!');
    expect(DEVICE_ID_PATTERN.test(id)).toBeTrue();
  });

  it('the name is empty at first, then trimmed, cut to the limit and stored', () => {
    const service = TestBed.inject(DeviceService);
    expect(service.name()).toBe('');
    service.setName('  كاشير 1  ');
    expect(service.name()).toBe('كاشير 1');
    expect(localStorage.getItem('nota.deviceName')).toBe('كاشير 1');
    service.setName('x'.repeat(100));
    expect(service.name().length).toBe(DEVICE_NAME_MAX);
    TestBed.resetTestingModule();
    expect(TestBed.inject(DeviceService).name().length).toBe(DEVICE_NAME_MAX);
  });

  it('with localStorage unavailable the browser is a new device each time and nothing throws', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('blocked');
    spyOn(Storage.prototype, 'setItem').and.throwError('blocked');
    const service = TestBed.inject(DeviceService);
    expect(DEVICE_ID_PATTERN.test(service.deviceId)).toBeTrue();
    expect(service.name()).toBe('');
    service.setName('كاشير 2');
    expect(service.name()).toBe('كاشير 2'); // kept in memory for this page
  });
});

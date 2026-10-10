import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Facing = 'user' | 'environment';
type FakeDevice = { id: string; label: string; facing?: Facing };
type Target = string | { facingMode: Facing | { exact: Facing } };

const m = vi.hoisted(() => ({
  instances: [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; scanFile: ReturnType<typeof vi.fn>; isScanning: boolean }>,
  onSuccess: null as ((text: string) => void) | null,
  startError: null as unknown,
  devices: [] as FakeDevice[],
  getCameras: null as ReturnType<typeof vi.fn> | null,
}));

vi.mock('html5-qrcode', () => {
  /** Picks a camera the way a browser does: an exact id or facing must match, a plain facing is a wish. */
  function pick(target: Target): FakeDevice | undefined {
    if (typeof target === 'string') return m.devices.find((device) => device.id === target);
    const facing = target.facingMode;
    if (typeof facing === 'object') return m.devices.find((device) => device.facing === facing.exact);
    return m.devices.find((device) => device.facing === facing) ?? m.devices[0];
  }
  class Html5Qrcode {
    isScanning = false;
    running: FakeDevice | undefined;
    start = vi.fn(async (target: Target, _config: unknown, onSuccess: (text: string) => void) => {
      if (m.startError) { const error = m.startError; m.startError = null; throw error; }
      const device = pick(target);
      if (!device) throw `Error getting userMedia, error = OverconstrainedError: no ${JSON.stringify(target)}`;
      this.running = device;
      this.isScanning = true;
      m.onSuccess = onSuccess;
      return null;
    });
    stop = vi.fn(async () => { this.isScanning = false; });
    clear = vi.fn();
    scanFile = vi.fn(async () => 'qr-from-photo');
    getRunningTrackSettings = vi.fn(() => ({ deviceId: this.running?.id, facingMode: this.running?.facing }));
    static getCameras = (m.getCameras = vi.fn(async () => m.devices));
    constructor() { m.instances.push(this); }
  }
  return { Html5Qrcode };
});

import { QrScanner } from './QrScanner';

const ENGLISH = /Request Camera|Scan an Image|Stop Scanning|Start Scanning|Select Camera|Scan using camera/i;
const IPHONE: FakeDevice[] = [
  { id: 'front', label: '전면 카메라', facing: 'user' },
  { id: 'triple', label: '후면 트리플 카메라', facing: 'environment' },
  { id: 'wide', label: '후면 울트라 와이드 카메라', facing: 'environment' },
  { id: 'back', label: '후면 카메라', facing: 'environment' },
];

beforeEach(() => {
  m.instances.length = 0;
  m.onSuccess = null;
  m.startError = null;
  m.devices = [];
  m.getCameras?.mockClear();
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn(),
      enumerateDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: 'mic', label: '마이크' },
        ...m.devices.map((device) => ({ kind: 'videoinput', deviceId: device.id, label: device.label })),
      ]),
    },
    configurable: true,
  });
  window.localStorage.clear();
});
afterEach(() => { cleanup(); });

describe('QrScanner', () => {
  it('starts the rear camera with Korean controls only and never shows the scanned QR value', async () => {
    m.devices = [{ id: 'cam', label: '' }];
    const onScan = vi.fn();
    const { container } = render(<QrScanner onScan={onScan} />);

    expect(await screen.findByText('QR 코드를 네모 칸 안에 보여 주세요.')).toBeTruthy();
    const scanner = m.instances.at(-1)!;
    expect(scanner.start).toHaveBeenCalledWith({ facingMode: 'environment' }, expect.objectContaining({ fps: 10 }), expect.any(Function), expect.any(Function));
    expect(screen.getByRole('button', { name: '카메라 끄기' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '사진으로 QR 읽기' })).toBeTruthy();
    // One camera: nothing to switch to.
    expect(screen.queryByRole('button', { name: /카메라로 바꾸기/ })).toBeNull();
    expect(container.textContent).not.toMatch(ENGLISH);

    act(() => { m.onSuccess!('  csq1.secret-student-token  '); m.onSuccess!('csq1.secret-student-token'); });
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith('csq1.secret-student-token');
    expect(screen.getByText('QR을 인식했어요.')).toBeTruthy();
    expect(container.textContent).not.toContain('secret-student-token');
  });

  it('switches a phone between front and rear only, never listing every lens or opening a second camera', async () => {
    m.devices = IPHONE;
    const { container } = render(<QrScanner onScan={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '전면 카메라로 바꾸기' }));
    const scanner = m.instances.at(-1)!;
    expect(await screen.findByRole('button', { name: '후면 카메라로 바꾸기' })).toBeTruthy();
    expect(scanner.start).toHaveBeenLastCalledWith({ facingMode: { exact: 'user' } }, expect.anything(), expect.any(Function), expect.any(Function));
    expect(window.localStorage.getItem('crs:qr-camera')).toBe('user');
    expect(container.querySelector('.crs-qr-reader')?.hasAttribute('data-mirror')).toBe(true);

    await waitFor(() => expect((screen.getByRole('button', { name: '후면 카메라로 바꾸기' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '후면 카메라로 바꾸기' }));
    expect(await screen.findByRole('button', { name: '전면 카메라로 바꾸기' })).toBeTruthy();
    expect(scanner.start).toHaveBeenLastCalledWith({ facingMode: { exact: 'environment' } }, expect.anything(), expect.any(Function), expect.any(Function));
    expect(window.localStorage.getItem('crs:qr-camera')).toBe('environment');
    expect(container.querySelector('.crs-qr-reader')?.hasAttribute('data-mirror')).toBe(false);

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(container.textContent).not.toMatch(/트리플|울트라 와이드/);
    // Html5Qrcode.getCameras() would open another camera, which blacks out the preview on iPhone.
    expect(m.getCameras).not.toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('turns to the next camera, round and round, when the cameras do not say which way they face (computers)', async () => {
    m.devices = [{ id: 'built-in', label: 'FaceTime HD 카메라' }, { id: 'usb', label: 'USB 카메라' }];
    render(<QrScanner onScan={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '다른 카메라로 바꾸기' }));
    const scanner = m.instances.at(-1)!;
    await waitFor(() => expect(scanner.start).toHaveBeenLastCalledWith('usb', expect.anything(), expect.any(Function), expect.any(Function)));
    expect(window.localStorage.getItem('crs:qr-camera')).toBe('device:usb');

    await waitFor(() => expect((screen.getByRole('button', { name: '다른 카메라로 바꾸기' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '다른 카메라로 바꾸기' }));
    await waitFor(() => expect(scanner.start).toHaveBeenLastCalledWith('built-in', expect.anything(), expect.any(Function), expect.any(Function)));
  });

  it('moves on to the next camera when a front-facing webcam has no rear one beside it', async () => {
    m.devices = [{ id: 'built-in', label: '내장 카메라', facing: 'user' }, { id: 'usb', label: 'USB 카메라' }];
    render(<QrScanner onScan={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '후면 카메라로 바꾸기' }));
    const scanner = m.instances.at(-1)!;
    expect(await screen.findByRole('button', { name: '다른 카메라로 바꾸기' })).toBeTruthy();
    expect(scanner.start).toHaveBeenCalledWith({ facingMode: { exact: 'environment' } }, expect.anything(), expect.any(Function), expect.any(Function));
    expect(scanner.start).toHaveBeenLastCalledWith('usb', expect.anything(), expect.any(Function), expect.any(Function));
    expect(screen.getByText('QR 코드를 네모 칸 안에 보여 주세요.')).toBeTruthy();
  });

  it('starts with the remembered front camera and forgets the old camera-list choice', async () => {
    m.devices = IPHONE;
    window.localStorage.setItem('crs:qr-camera', 'user');
    window.localStorage.setItem('crs:qr-camera-id', 'wide');
    render(<QrScanner onScan={vi.fn()} />);

    expect(await screen.findByRole('button', { name: '후면 카메라로 바꾸기' })).toBeTruthy();
    expect(m.instances.at(-1)!.start).toHaveBeenCalledWith({ facingMode: 'user' }, expect.anything(), expect.any(Function), expect.any(Function));
    expect(window.localStorage.getItem('crs:qr-camera-id')).toBeNull();
  });

  it('explains a blocked camera in Korean and tries again from [카메라 켜기]', async () => {
    m.devices = IPHONE;
    m.startError = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    render(<QrScanner onScan={vi.fn()} />);

    expect(await screen.findByText(/카메라 사용이 막혀 있어요/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '카메라 켜기' }));
    expect(await screen.findByText('QR 코드를 네모 칸 안에 보여 주세요.')).toBeTruthy();
  });

  it('offers reading a photo when the browser has no camera access', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    const onScan = vi.fn();
    render(<QrScanner onScan={onScan} />);

    expect(await screen.findByText(/이 브라우저에서는 카메라를 쓸 수 없어요/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '카메라 켜기' }) as HTMLButtonElement).disabled).toBe(true);
    const photo = new File(['png'], 'qr.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('QR 사진 선택'), { target: { files: [photo] } });
    await waitFor(() => expect(onScan).toHaveBeenCalledWith('qr-from-photo'));
  });

  it('reads a photo by pausing the camera, then turns the same camera back on', async () => {
    m.devices = IPHONE;
    const onScan = vi.fn();
    render(<QrScanner onScan={onScan} />);
    await screen.findByText('QR 코드를 네모 칸 안에 보여 주세요.');
    const scanner = m.instances.at(-1)!;

    fireEvent.change(screen.getByLabelText('QR 사진 선택'), { target: { files: [new File(['png'], 'qr.png', { type: 'image/png' })] } });
    await waitFor(() => expect(onScan).toHaveBeenCalledWith('qr-from-photo'));
    expect(scanner.stop).toHaveBeenCalled();
    expect(scanner.scanFile).toHaveBeenCalledWith(expect.any(File), false);
    await waitFor(() => expect(scanner.start).toHaveBeenCalledTimes(2));
    expect(scanner.start).toHaveBeenLastCalledWith('triple', expect.anything(), expect.any(Function), expect.any(Function));
  });
});

'use client';

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import type { Html5Qrcode } from 'html5-qrcode';
import { buttonClass } from './ui/classes';
import { Icon } from './ui/icons';

type QrScannerProps = {
  onScan: (decodedText: string) => void;
};

type Phase = 'starting' | 'scanning' | 'stopped' | 'blocked' | 'unavailable';
type Facing = 'user' | 'environment';
/** A camera device id (exact), or a facing direction (exact only when switching). */
type CameraTarget = string | { facingMode: Facing | { exact: Facing } };
type RunningCamera = Readonly<{ deviceId: string | null; facing: Facing | null }>;

const PREFERENCE_KEY = 'crs:qr-camera';
/** Before the front/rear switch, a device id picked from a camera list was kept here. */
const OLD_CAMERA_KEY = 'crs:qr-camera-id';
const REAR: CameraTarget = { facingMode: 'environment' };
const NO_CAMERA: RunningCamera = { deviceId: null, facing: null };
// No aspectRatio: changing the live camera's shape (applyConstraints) is a risk on iPhone Safari.
const SCAN_CONFIG = { fps: 10, qrbox: { width: 220, height: 220 } };

const MESSAGES = {
  starting: '카메라를 켜는 중이에요.',
  switching: '카메라를 바꾸는 중이에요.',
  scanning: 'QR 코드를 네모 칸 안에 보여 주세요.',
  switchFailed: '다른 카메라로 바꾸지 못했어요. 지금 카메라로 QR을 보여 주세요.',
  stopped: '카메라가 꺼져 있어요. [카메라 켜기]를 눌러 주세요.',
  blocked: '카메라 사용이 막혀 있어요. 주소창 옆의 카메라 표시를 눌러 허용한 뒤 [카메라 켜기]를 눌러 주세요.',
  noCamera: '카메라를 찾지 못했어요. [사진으로 QR 읽기]를 이용해 주세요.',
  unsupported: '이 브라우저에서는 카메라를 쓸 수 없어요. [사진으로 QR 읽기]를 이용해 주세요.',
  failed: '카메라를 켜지 못했어요. 잠시 뒤 [카메라 켜기]를 다시 눌러 주세요.',
  recognized: 'QR을 인식했어요.',
  readingPhoto: '사진에서 QR을 찾는 중이에요.',
  photoMissed: '사진에서 QR을 찾지 못했어요. QR이 크고 또렷하게 보이도록 다시 찍어 주세요.',
} as const;

function readPreference(): CameraTarget | null {
  try {
    window.localStorage.removeItem(OLD_CAMERA_KEY);
    const saved = window.localStorage.getItem(PREFERENCE_KEY);
    if (saved === 'user' || saved === 'environment') return { facingMode: saved };
    if (saved?.startsWith('device:') && saved.length > 'device:'.length) return saved.slice('device:'.length);
  } catch { /* Remembering the camera is only a convenience. */ }
  return null;
}

/** Phones remember a direction (front/rear); cameras without one (computer webcams) remember the device. */
function savePreference(camera: RunningCamera) {
  const value = camera.facing ?? (camera.deviceId ? `device:${camera.deviceId}` : null);
  if (!value) return;
  try { window.localStorage.setItem(PREFERENCE_KEY, value); } catch { /* Remembering the camera is only a convenience. */ }
}

/**
 * Counts cameras without opening one. Html5Qrcode.getCameras() opens the default camera (the front one
 * on a phone) and closes it again; on iPhone Safari that silences the camera already showing, which
 * leaves the preview black. Once the camera is on, enumerateDevices() already lists them.
 */
async function listCameraIds(): Promise<string[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'videoinput' && device.deviceId).map((device) => device.deviceId);
  } catch {
    return [];
  }
}

function runningCamera(reader: Html5Qrcode): RunningCamera {
  try {
    const settings = reader.getRunningTrackSettings();
    const facing = settings.facingMode === 'user' || settings.facingMode === 'environment' ? settings.facingMode : null;
    return { deviceId: settings.deviceId || null, facing };
  } catch {
    return NO_CAMERA;
  }
}

/**
 * Where [카메라 전환] goes. A phone camera says which way it faces, so the switch is simply front ↔ rear
 * (a phone lists every rear lens separately, which is confusing to pick from). A computer webcam usually
 * says nothing, so the switch moves on to the next camera, and goes round when it reaches the last one.
 */
function switchTargets(current: RunningCamera, cameraIds: readonly string[]): CameraTarget[] {
  const targets: CameraTarget[] = [];
  if (current.facing) targets.push({ facingMode: { exact: current.facing === 'user' ? 'environment' : 'user' } });
  const index = current.deviceId ? cameraIds.indexOf(current.deviceId) : -1;
  const next = cameraIds.length > 1 ? cameraIds[(index + 1) % cameraIds.length] : undefined;
  if (next && next !== current.deviceId) targets.push(next);
  return targets;
}

function switchLabel(current: RunningCamera) {
  if (current.facing === 'environment') return '전면 카메라로 바꾸기';
  if (current.facing === 'user') return '후면 카메라로 바꾸기';
  return '다른 카메라로 바꾸기';
}

function cameraFailure(error: unknown): Readonly<{ phase: Phase; message: string }> {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/NotAllowed|Permission|denied/i.test(text)) return { phase: 'blocked', message: MESSAGES.blocked };
  // No camera right now: [카메라 켜기] stays available for when one is connected.
  if (/NotFound|Overconstrained|no camera|Requested device not found/i.test(text)) return { phase: 'stopped', message: MESSAGES.noCamera };
  return { phase: 'stopped', message: MESSAGES.failed };
}

/**
 * Camera QR reader with Korean controls. It drives the headless Html5Qrcode engine; the library's
 * own scanner screen (Html5QrcodeScanner) has fixed English text, so it is not used.
 */
export function QrScanner({ onScan }: QrScannerProps) {
  const elementId = `crs-qr-reader-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const onScanRef = useRef(onScan);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(false);
  const lastDecoded = useRef('');
  const fileInput = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<RunningCamera>(NO_CAMERA);
  const cameraIdsRef = useRef<string[]>([]);
  const [phase, setPhase] = useState<Phase>('starting');
  const [message, setMessage] = useState<string>(MESSAGES.starting);
  const [camera, setCamera] = useState<RunningCamera>(NO_CAMERA);
  const [cameraCount, setCameraCount] = useState(0);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  /** Camera operations run one at a time, so a quick stop/start never overlaps. */
  const enqueue = useCallback(<T,>(work: () => Promise<T>) => {
    const next = queue.current.then(work, work);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  const scanner = useCallback(async () => {
    if (!scannerRef.current) {
      const { Html5Qrcode } = await import('html5-qrcode');
      scannerRef.current = new Html5Qrcode(elementId, { verbose: false });
    }
    return scannerRef.current;
  }, [elementId]);

  const handleDecoded = useCallback((decodedText: string) => {
    const text = decodedText.trim();
    if (!text || text === lastDecoded.current) return;
    lastDecoded.current = text;
    setMessage(MESSAGES.recognized);
    onScanRef.current(text);
  }, []);

  /** Starts the first camera that works, in order, and says which one. A blocked permission stops at once. */
  const startFirst = useCallback(async (reader: Html5Qrcode, targets: readonly CameraTarget[]) => {
    let lastError: unknown = new Error('NotFoundError no camera');
    for (const [index, target] of targets.entries()) {
      try {
        await reader.start(target, SCAN_CONFIG, handleDecoded, () => undefined);
        return index;
      } catch (error) {
        if (cameraFailure(error).phase === 'blocked') throw error;
        lastError = error;
      }
    }
    throw lastError;
  }, [handleDecoded]);

  /** Shows the camera that is now on and counts the cameras, without opening any of them. */
  const showRunning = useCallback(async (reader: Html5Qrcode) => {
    const running = runningCamera(reader);
    cameraRef.current = running;
    setCamera(running);
    setPhase('scanning');
    const ids = await listCameraIds();
    cameraIdsRef.current = ids;
    if (mounted.current) setCameraCount(ids.length);
    return running;
  }, []);

  const startCamera = useCallback((target?: CameraTarget) => enqueue(async () => {
    if (!mounted.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase('unavailable');
      setMessage(MESSAGES.unsupported);
      return;
    }
    setPhase('starting');
    setMessage(MESSAGES.starting);
    try {
      const reader = await scanner();
      if (reader.isScanning) await reader.stop();
      const wanted = target ?? readPreference();
      // A remembered camera may be gone (another device, unplugged): fall back to the rear camera.
      await startFirst(reader, wanted ? [wanted, REAR] : [REAR]);
      if (!mounted.current) {
        await reader.stop().catch(() => undefined);
        return;
      }
      setMessage(MESSAGES.scanning);
      await showRunning(reader);
    } catch (error) {
      if (!mounted.current) return;
      const failure = cameraFailure(error);
      setPhase(failure.phase);
      setMessage(failure.message);
    }
  }), [enqueue, scanner, showRunning, startFirst]);

  const switchCamera = useCallback(() => enqueue(async () => {
    const reader = scannerRef.current;
    const before = cameraRef.current;
    const targets = switchTargets(before, cameraIdsRef.current);
    if (!reader || !mounted.current || targets.length === 0) return;
    setPhase('starting');
    setMessage(MESSAGES.switching);
    try {
      if (reader.isScanning) await reader.stop();
      // When no other camera starts, the one that was on comes back.
      const started = await startFirst(reader, [...targets, before.deviceId ?? REAR]);
      if (!mounted.current) {
        await reader.stop().catch(() => undefined);
        return;
      }
      const switched = started < targets.length;
      setMessage(switched ? MESSAGES.scanning : MESSAGES.switchFailed);
      const running = await showRunning(reader);
      if (switched) savePreference(running);
    } catch (error) {
      if (!mounted.current) return;
      const failure = cameraFailure(error);
      setPhase(failure.phase);
      setMessage(failure.message);
    }
  }), [enqueue, showRunning, startFirst]);

  const stopCamera = useCallback(() => enqueue(async () => {
    const reader = scannerRef.current;
    if (reader?.isScanning) await reader.stop().catch(() => undefined);
    if (mounted.current) {
      setPhase('stopped');
      setMessage(MESSAGES.stopped);
    }
  }), [enqueue]);

  useEffect(() => {
    mounted.current = true;
    void startCamera();
    return () => {
      mounted.current = false;
      void enqueue(async () => {
        const reader = scannerRef.current;
        if (reader?.isScanning) await reader.stop().catch(() => undefined);
        try { reader?.clear(); } catch { /* Already cleared. */ }
        scannerRef.current = null;
      });
    };
  }, [enqueue, startCamera]);

  /** Turns the camera back on as it was: the same device when known, else the remembered choice. */
  function restartCamera() {
    void startCamera(cameraRef.current.deviceId ?? undefined);
  }

  function readPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const wasScanning = phase === 'scanning';
    void enqueue(async () => {
      setMessage(MESSAGES.readingPhoto);
      try {
        const reader = await scanner();
        if (reader.isScanning) await reader.stop();
        const text = await reader.scanFile(file, false);
        lastDecoded.current = '';
        handleDecoded(text);
      } catch {
        if (mounted.current) setMessage(MESSAGES.photoMissed);
      }
    }).then(() => {
      if (wasScanning && mounted.current) restartCamera();
    });
  }

  const cameraOn = phase === 'scanning' || phase === 'starting';
  const label = switchLabel(camera);
  return (
    <div className="w-full max-w-xl rounded-[18px] bg-white p-3 text-slate-900">
      <div className="relative overflow-hidden rounded-[14px] bg-slate-900">
        {/* A front camera is shown mirrored, as camera apps do; QR reading uses the unmirrored picture. */}
        <div id={elementId} className="crs-qr-reader min-h-[220px] w-full" data-mirror={camera.facing === 'user' ? '' : undefined} />
        {phase !== 'scanning' ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[13px] font-semibold leading-relaxed text-white/80">
            {phase === 'starting' ? message : '카메라 화면이 여기에 나와요.'}
          </p>
        ) : null}
        {cameraOn && cameraCount > 1 ? (
          <button type="button" aria-label={label} title={label} onClick={() => void switchCamera()} disabled={phase !== 'scanning'}
            className="absolute bottom-2.5 right-2.5 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-opacity hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40">
            <Icon name="cameraFlip" size={22} strokeWidth={1.9} />
          </button>
        ) : null}
      </div>
      <p role="status" className="mt-2.5 flex items-center justify-center gap-1.5 text-center text-[13px] font-semibold text-slate-500">
        <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${phase === 'scanning' ? 'animate-pulse bg-emerald-500' : 'bg-slate-300'}`} />
        {message}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">
        {cameraOn ? (
          <button type="button" className={buttonClass({ variant: 'secondary', size: 'sm' })} onClick={() => void stopCamera()} disabled={phase === 'starting'}>
            카메라 끄기
          </button>
        ) : (
          <button type="button" className={buttonClass({ variant: 'primary', size: 'sm' })} onClick={restartCamera} disabled={phase === 'unavailable'}>
            카메라 켜기
          </button>
        )}
        <button type="button" className={buttonClass({ variant: 'soft', size: 'sm' })} onClick={() => fileInput.current?.click()}>
          사진으로 QR 읽기
        </button>
        <input ref={fileInput} type="file" accept="image/*" className="hidden" aria-label="QR 사진 선택" onChange={readPhoto} />
      </div>
    </div>
  );
}

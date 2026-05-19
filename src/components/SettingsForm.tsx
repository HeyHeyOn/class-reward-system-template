'use client';

import { FormEvent, useEffect, useState } from 'react';

type SettingsResponse = {
  spreadsheetId: string;
  source: 'runtime' | 'env' | 'unset';
};

export function SettingsForm() {
  const [spreadsheetIdOrUrl, setSpreadsheetIdOrUrl] = useState('');
  const [currentSettings, setCurrentSettings] = useState<SettingsResponse | null>(null);
  const [message, setMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let ignore = false;

    async function loadSettings() {
      const response = await fetch('/api/settings', { cache: 'no-store' });
      const settings = (await response.json()) as SettingsResponse;

      if (!ignore) {
        setCurrentSettings(settings);
        setSpreadsheetIdOrUrl(settings.spreadsheetId);
      }
    }

    loadSettings().catch(() => {
      if (!ignore) setMessage('현재 설정을 불러오지 못했습니다.');
    });

    return () => {
      ignore = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setMessage('');

    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheetIdOrUrl }),
      });
      const payload = (await response.json()) as SettingsResponse | { error: string };

      if (!response.ok || 'error' in payload) {
        setMessage('error' in payload ? payload.error : '설정을 저장하지 못했습니다.');
        return;
      }

      setCurrentSettings(payload);
      setSpreadsheetIdOrUrl(payload.spreadsheetId);
      setMessage('시트 ID를 저장했습니다.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-[2rem] bg-white p-6 shadow-sm ring-1 ring-black/5">
      <div className="space-y-2">
        <p className="text-sm font-bold tracking-[0.2em] text-amber-700">GOOGLE SHEETS</p>
        <h2 className="text-3xl font-black">스프레드시트 연결</h2>
        <p className="text-slate-600">
          Google Sheets 주소 전체 또는 `/d/` 사이의 시트 ID만 넣어도 됩니다. 저장된 값은 이 설치본의
          `data/settings.json`에 보관됩니다.
        </p>
      </div>

      <label className="mt-6 block">
        <span className="text-sm font-bold text-slate-700">Google Sheets 주소 또는 시트 ID</span>
        <input
          value={spreadsheetIdOrUrl}
          onChange={(event) => setSpreadsheetIdOrUrl(event.target.value)}
          placeholder="https://docs.google.com/spreadsheets/d/.../edit"
          className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-lg outline-none transition focus:border-amber-500 focus:bg-white"
        />
      </label>

      <div className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
        <p>
          현재 상태:{' '}
          <strong className="text-slate-950">
            {currentSettings?.spreadsheetId ? '연결 ID 있음' : '미설정'}
          </strong>
        </p>
        <p>설정 출처: {currentSettings?.source ?? '확인 중'}</p>
      </div>

      {message ? <p className="mt-4 font-bold text-amber-700">{message}</p> : null}

      <button
        type="submit"
        disabled={isSaving}
        className="mt-6 w-full rounded-2xl bg-slate-950 py-4 text-xl font-black text-white shadow-lg transition hover:bg-slate-800 disabled:cursor-wait disabled:bg-slate-400"
      >
        {isSaving ? '저장 중...' : '시트 ID 저장'}
      </button>
    </form>
  );
}

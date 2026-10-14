'use client';

import { useId, useRef, useState } from 'react';
import { Button, Callout, Field, Input, Modal } from '../ui';
import { parentConsentFormPdf } from '@/lib/documentCanvas';
import { CONSENT_FORM_TITLE, consentFormFileName } from '@/lib/parentConsentForm';
import { downloadBlob } from '@/lib/shareCard';

const DOCUMENT_FONT = '"Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", "Noto Sans KR", "Noto Sans CJK KR", sans-serif';

/**
 * The parent (법정대리인) consent form a teacher prints and sends home before entering students' real
 * 학년·반, 번호 and 이름. A few details are filled in here; fields left empty print as blanks.
 */
export function ParentConsentFormDialog({ classLabel, onClose, opener }: {
  /** Prefills 학년·반, e.g. "5학년 2반". */
  classLabel: string;
  onClose: () => void;
  opener?: HTMLElement | null;
}) {
  const [schoolName, setSchoolName] = useState('');
  const [label, setLabel] = useState(classLabel);
  const [teacherName, setTeacherName] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  async function download() {
    setBusy(true);
    setNotice('');
    try {
      // An official form: a plain Korean sans font, not the decorative font a class may use on screen.
      const fontFamily = DOCUMENT_FONT;
      const blob = await parentConsentFormPdf(
        { schoolName: schoolName.trim(), classLabel: label.trim(), teacherName: teacherName.trim(), dueDate: dueDate.trim() },
        { fontFamily },
      );
      downloadBlob(blob, consentFormFileName(label));
      setNotice('동의서 PDF를 내려받았어요.');
    } catch {
      setNotice('동의서를 만들지 못했어요. 잠시 뒤 다시 눌러 주세요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={CONSENT_FORM_TITLE} onClose={onClose} opener={opener} busy={busy} size="md"
      footer={(
        <Button variant="primary" icon="download" loading={busy} disabled={busy} onClick={() => void download()}>PDF로 내려받기</Button>
      )}>
      <div ref={bodyRef} className="space-y-4">
        <p className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
          만 14세 미만 학생의 실명과 학년, 반, 번호를 입력하려면 법정대리인(학부모)의 동의가 필요해요.
          이 동의서를 인쇄해 가정에 보내 서명을 받고, 받은 동의서는 선생님이 보관해 주세요.
        </p>
        <Callout tone="info">동의를 받지 않은 학생은 실명 대신 별명과 임의 번호로 등록해 주세요.</Callout>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="학교 이름" htmlFor={`${id}-school`} optional>
            <Input id={`${id}-school`} value={schoolName} onChange={(event) => setSchoolName(event.target.value)} placeholder="예: 햇살초등학교" maxLength={40} autoComplete="off" />
          </Field>
          <Field label="학년·반" htmlFor={`${id}-class`}>
            <Input id={`${id}-class`} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="예: 5학년 2반" maxLength={40} autoComplete="off" />
          </Field>
          <Field label="담임교사 이름" htmlFor={`${id}-teacher`} optional>
            <Input id={`${id}-teacher`} value={teacherName} onChange={(event) => setTeacherName(event.target.value)} maxLength={20} autoComplete="off" />
          </Field>
          <Field label="회신 기한" htmlFor={`${id}-due`} optional>
            <Input id={`${id}-due`} value={dueDate} onChange={(event) => setDueDate(event.target.value)} placeholder="예: 3월 15일" maxLength={30} autoComplete="off" />
          </Field>
        </div>
        <p className="text-xs leading-relaxed text-[var(--theme-muted-text)]">
          비워 둔 칸은 동의서에 빈칸으로 나와 손으로 적을 수 있어요. 회신 기한을 적으면 &lsquo;○○까지 담임교사에게 제출해 주세요.&rsquo;가 함께 인쇄돼요.
        </p>
        <p role="status" className="min-h-[18px] text-center text-[12.5px] font-semibold text-[var(--theme-muted-text)]">{notice}</p>
      </div>
    </Modal>
  );
}

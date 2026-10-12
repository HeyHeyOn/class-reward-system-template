import type { AdminTab } from '../admin/adminTypes';

/*
 * Tutorials that walk the teacher through a feature on the real admin screen. Each step lights up
 * one "understanding unit" (a field with its label and hint, a button with the header it belongs
 * to, …), points an arrow at the control to use, and explains it in the guide's words. Whatever the
 * teacher types or saves is real; the tutorial itself only ever opens dialogs or switches tabs.
 *
 * Targets are CSS selectors on stable hooks: ids, aria-labels and `data-tour` attributes.
 */

/** Part of the lit area, found from the step's target (or anywhere, for a plain selector). */
export type TutorialArea =
  | '@target'   // the target itself
  | '@field'    // the field around it: label, control and hint (`data-field`)
  | '@header'   // the page header it sits in: title, description and actions
  | '@footer'   // the dialog footer it sits in
  | '@parent'   // its parent element
  | Readonly<{ closest: string }>
  | string;     // any other element (first visible match)

export type TutorialStep = Readonly<{
  /** Admin menu to show before this step. */
  tab?: AdminTab;
  /** What the arrow points at: the first visible match; alternatives in order. */
  target: string | readonly string[];
  /** The understanding unit to light up. Default: the target's field, or the target. */
  area?: readonly TutorialArea[];
  title: string;
  /** **굵게**, [버튼 이름] */
  text: string;
  sub?: string;
  /** Shown in amber: what really happens when the teacher does this. */
  warn?: string;
  /** Put the cursor in the target. */
  focus?: boolean;
  /** 다음 does this harmless click first (open a dialog or a tab) and waits for `wait`. */
  next?: Readonly<{ click?: string; wait: string }>;
  /** Moves on by itself once this appears after the step began (the teacher clicked). */
  advanceWhen?: string;
  /** Said when the target is not on the screen (a menu only on wide screens, …). */
  missing?: string;
}>;

export type Tutorial = Readonly<{
  id: string;
  title: string;
  goal: string;
  /** Needs the stage-ledger task screen (PostgreSQL classes). */
  ledger?: boolean;
  steps: readonly TutorialStep[];
}>;

const dialog = (name: string) => `[role="dialog"][aria-label="${name}"]`;

export const TUTORIALS: readonly Tutorial[] = [
  {
    id: '2-1',
    title: '매점·은행 이름과 화폐 단위 정하기',
    goal: '학생 화면 맨 위의 이름과, 학급에서 쓰는 돈의 단위를 바꿔요.',
    steps: [
      { tab: 'settings', target: '#settings-app-title', focus: true, title: '매점 이름',
        text: '**매점 이름**을 적으세요. 매점 화면 맨 위에 보여요.', sub: '예: 6학년 3반 매점, 햇살 가게' },
      { tab: 'settings', target: '#settings-bank-title', focus: true, title: '은행 이름',
        text: '**은행 이름**을 적으세요. 은행 화면 맨 위에 보여요.', sub: '예: 6학년 3반 은행' },
      { tab: 'settings', target: '#settings-currency', focus: true, title: '화폐 단위',
        text: '**화폐 단위**를 적으세요. 모든 금액 뒤에 붙어요.', sub: '예: 원 · 별 · 포인트 — 1,000원이 1,000별로 바뀌어요.' },
      { tab: 'settings', target: '[data-tour="settings-save"]', area: ['[data-tour="settings-save-bar"]'], title: '저장하기',
        text: '[설정 저장]을 누르세요.', sub: '‘저장하지 않은 변경 사항이 있습니다’가 보이면 아직 저장 전이에요. 바꾼 것이 없으면 버튼이 흐려요.',
        warn: '저장하면 매점·은행 화면에 바로 반영돼요.' },
    ],
  },
  {
    id: '3-1',
    title: '학생 한 명씩 추가하기',
    goal: '번호·이름·처음 잔액을 넣어 학생을 한 명 등록해요.',
    steps: [
      { tab: 'students', target: '[data-tour="student-add"]', area: ['@header'], title: '추가 창 열기',
        text: '[학생 추가]를 누르세요. 오른쪽에 입력 창이 열려요.', next: { wait: '#new-student-id' }, advanceWhen: '#new-student-id' },
      { target: '#new-student-id', focus: true, title: '번호',
        text: '**번호**를 적으세요. QR 카드에 들어가는 학생 고유 번호예요.', sub: '반 안에서 겹치면 안 돼요. 예: 01, 6301' },
      { target: '#new-student-name', focus: true, title: '이름',
        text: '**이름**을 적으세요.', warn: '만 14세 미만 학생의 실명은 학부모(법정대리인) 동의를 받은 뒤에 적어 주세요. 동의 전이면 별명을 써요.' },
      { target: '#new-student-balance', focus: true, title: '처음 잔액',
        text: '**처음 잔액**을 적으세요.', sub: '비워 두면 0이에요. 음수로도 시작할 수 있어요.' },
      { target: '[data-tour="student-create"]', area: ['@footer'], title: '추가하기',
        text: '[새 학생 추가]를 누르면 명단에 들어가요.', warn: '누르면 학생이 실제로 추가돼요. 추가한 학생의 번호는 지워도 다시 쓸 수 없어요.' },
    ],
  },
  {
    id: '3-5',
    title: '학생 QR 카드 인쇄하기',
    goal: 'QR 카드는 학생의 결제 수단이자 은행 로그인 열쇠예요. 인쇄해서 잘라 나눠 줘요.',
    steps: [
      { target: 'a[href$="/admin/student-qrs"]', area: ['[data-tour="sidebar-shortcuts"]'], title: '반 전체 인쇄',
        text: '왼쪽 바로가기의 [학생 QR 인쇄]를 누르면 새 탭에 활성 학생 모두의 QR 카드가 나와요. 그 화면에서 [QR 카드 인쇄하기]를 누르세요.',
        sub: '코팅하거나 카드 지갑에 넣어 쓰면 오래 써요.', missing: '[학생 QR 인쇄]는 넓은 화면(컴퓨터)의 왼쪽 바로가기에 있어요. [다음]으로 몇 명만 뽑는 방법을 볼 수 있어요.' },
      { tab: 'students', target: '[data-testid="student-row"] input[type="checkbox"]', area: [{ closest: '[data-testid="student-row"]' }], title: '몇 명만 고르기',
        text: '몇 명만 다시 뽑을 때는 학생 줄 왼쪽 **체크 상자**로 학생을 고르세요.', sub: '맨 위 체크 상자는 전체 선택이에요.',
        next: { wait: '[data-tour="student-qr-bulk"]' }, advanceWhen: '[data-tour="student-qr-bulk"]',
        missing: '먼저 학생을 등록해 주세요. 학생 추가는 3-1 튜토리얼에서 볼 수 있어요.' },
      { target: '[data-tour="student-qr-bulk"]', area: [{ closest: '[role="toolbar"]' }], title: '고른 학생만 인쇄',
        text: '[QR 카드 발급]을 누르면 고른 학생의 카드만 나와요. 창에서 [인쇄]를 누르세요.',
        warn: 'QR 카드만 있으면 매점 결제와 은행 로그인이 돼요. 친구에게 빌려주거나 사진으로 찍어 공유하지 않도록 지도해 주세요.' },
    ],
  },
  {
    id: '4-1',
    title: '매점에 상품 추가하기',
    goal: '이름·가격·재고·분류를 넣어 매점에 새 상품을 올려요.',
    steps: [
      { tab: 'products', target: '[data-tour="product-add"]', area: ['@header'], title: '추가 창 열기',
        text: '[상품 추가]를 누르세요. 오른쪽에 입력 창이 열려요.', next: { wait: '#new-product-name' }, advanceWhen: '#new-product-name' },
      { target: '#new-product-image', focus: true, title: '이미지 주소 (선택)',
        text: '그림을 넣으려면 **이미지 주소**를 붙여 넣으세요.', sub: '인터넷 그림에서 마우스 오른쪽 버튼 → ‘이미지 주소 복사’. 비워 둬도 돼요.' },
      { target: '#new-product-name', focus: true, title: '상품 이름', text: '**상품 이름**을 적으세요.' },
      { target: '#new-product-price', focus: true, title: '가격', text: '**가격**을 적으세요.' },
      { target: '#new-product-stock', focus: true, title: '재고', text: '**재고** 수를 적으세요. 0이 되면 팔리지 않아요.' },
      { target: '#new-product-category', focus: true, title: '분류 (선택)',
        text: '**분류**를 적거나 고르세요. 같은 분류끼리 매점 화면의 탭으로 묶여요.', sub: '예: 간식, 학용품, 특권' },
      { target: '#new-product-order', focus: true, title: '목록 순서', text: '**목록 순서** — 작은 숫자가 앞에 보여요.' },
      { target: '[aria-label="새 상품 판매중"]', title: '판매 중', text: '**판매 중**을 끄면 매점에서 숨겨져요.', sub: '잠시 팔지 않을 때 끄면 돼요.' },
      { target: '[aria-label="새 상품 디지털 상품"]', title: '디지털 상품',
        text: '**디지털 상품**을 켜면 산 물건이 학생 보관함에 들어가요.', sub: '자리 바꾸기권처럼 실물이 없는 특권에 써요.' },
      { target: '[data-tour="product-create"]', area: ['@footer'], title: '추가하기',
        text: '[새 상품 추가]를 누르세요.', warn: '누르면 매점에 바로 올라가요.' },
    ],
  },
  {
    id: '5-1',
    title: '새 과제 만들기',
    goal: '과제 이름·설명·보상과 기간을 정하고, 과제를 줄 학생을 골라요.',
    ledger: true,
    steps: [
      { tab: 'tasks', target: '[data-tour="task-new"]', area: ['@header'], title: '새 과제 창 열기',
        text: '[새 과제]를 누르세요. 오른쪽에 과제 창이 열려요.', next: { wait: dialog('새 과제') }, advanceWhen: dialog('새 과제') },
      { target: `${dialog('새 과제')} [role="tablist"]`, area: ['@target'], title: '탭 세 개',
        text: '창 위의 [기본 정보] · [반복] · [대상 학생] 탭을 차례로 채워요.', sub: '바꾼 탭에는 점이 붙어요. 반복은 매일·매주 다시 하는 과제에만 정하면 돼요.' },
      { target: '[aria-label="새 과제 과제 이름"]', focus: true, title: '과제 이름', text: '**과제 이름**을 적으세요.', sub: '예: 수학 익힘책 42~45쪽' },
      { target: '[aria-label="새 과제 설명"]', focus: true, title: '설명 (선택)', text: '**설명**을 적으세요. 학생이 은행에서 봐요.' },
      { target: '[aria-label="새 과제 보상"]', focus: true, title: '보상', text: '**보상** 금액을 적으세요. 학생이 완료하면 받아요.' },
      { target: '[aria-label="새 과제 학생에게 보이기"]', title: '학생에게 보이기', text: '**학생에게 보이기**를 끄면 은행에서 숨겨져요.' },
      { target: '[aria-label="새 과제 시작 시각"]', area: [{ closest: 'fieldset' }], title: '기간 (선택)',
        text: '**기간**을 정하세요. 시작을 비우면 바로, 마감을 비우면 마감 없이 열려요.' },
      { target: '[aria-label="새 과제 선행 과제"]', title: '먼저 끝내야 하는 과제 (선택)',
        text: '고르면 그 과제를 완료한 학생만 이 과제를 완료할 수 있어요.' },
      { target: `${dialog('새 과제')} [data-tour="sheet-tab-students"]`, area: [{ closest: '[role="tablist"]' }], title: '대상 학생 탭',
        text: '[대상 학생] 탭을 누르세요.', next: { click: `${dialog('새 과제')} [data-tour="sheet-tab-students"]`, wait: '[data-tour="task-targets-bar"]' },
        advanceWhen: '[data-tour="task-targets-bar"]' },
      { target: '[aria-label="모든 학생 고르기"]', area: ['[data-tour="task-targets-bar"]'], title: '학생 고르기',
        text: '**모든 학생**을 체크하면 반 전체를 골라요. 고른 뒤 **고른 학생 모두** 옆 버튼으로 처음 단계를 한꺼번에 정해요.',
        sub: '고르지 않은 학생은 미부여예요. 학생에게 보이지 않아요.' },
      { target: '[data-tour="task-target-row"] [role="group"]', area: [{ closest: '[data-tour="task-target-row"]' }], title: '학생마다 처음 단계',
        text: '학생 줄 오른쪽 버튼으로 학생마다 **처음 단계**를 바꿔요.', sub: '**미부여**를 누르면 그 학생은 대상에서 빠져요. 흔히 ‘미완료’로 내고, 확인한 학생을 ‘완료 가능’으로 바꿔요.' },
      { target: '[data-tour="task-create"]', area: ['@footer'], title: '만들기',
        text: '[과제 만들기]를 누르세요.', warn: '누르면 과제가 바로 만들어지고, 고른 학생의 은행 화면에 보여요.' },
    ],
  },
  {
    id: '5-4',
    title: '학생 단계 바꾸기 · 현황 보기',
    goal: '과제의 ‘학생 현황’ 탭에서 학생마다 단계를 바꾸고 저장해요.',
    ledger: true,
    steps: [
      { tab: 'tasks', target: '[data-testid="task-row"] button[aria-label$=" 과제 편집"]', area: [{ closest: '[data-testid="task-row"]' }], title: '과제 고르기',
        text: '단계를 바꿀 **과제 이름**을 누르세요.', sub: '[다음]을 누르면 맨 위 과제로 보여 드려요.',
        next: { wait: '[role="dialog"][aria-label$=" 과제 편집"]' }, advanceWhen: '[role="dialog"][aria-label$=" 과제 편집"]',
        missing: '먼저 과제를 만들어 주세요. 5-1 튜토리얼에서 볼 수 있어요.' },
      { target: '[role="dialog"][aria-label$=" 과제 편집"] [data-tour="sheet-tab-students"]', area: [{ closest: '[role="tablist"]' }], title: '학생 현황 탭',
        text: '[학생 현황] 탭을 누르세요.', next: { click: '[role="dialog"][aria-label$=" 과제 편집"] [data-tour="sheet-tab-students"]', wait: '[data-tour="stage-counts"]' },
        advanceWhen: '[data-tour="stage-counts"]' },
      { target: '[data-tour="stage-counts"]', area: ['@target'], title: '단계별 학생 수', text: '맨 위 숫자로 **단계별 학생 수**를 봐요.',
        sub: '미부여 → 미완료 → 완료 가능 → 완료. 학생은 ‘완료 가능’일 때만 은행에서 보상을 받아요.' },
      { target: '[aria-label="학생 현황 필터"]', area: ['@target'], title: '걸러 보기', text: '[전체 · 미부여 · 미완료 · 완료 가능 · 완료]로 학생을 걸러 봐요.' },
      { target: '[data-tour="stage-row"] [role="group"]', area: [{ closest: '[data-tour="stage-row"]' }], title: '단계 바꾸기',
        text: '학생 줄 오른쪽에서 **바꿀 단계**를 누르세요.', sub: '바꾼 학생은 파랗게 표시되고 ‘변경’이 붙어요. 여러 명을 체크한 뒤 한꺼번에 바꿀 수도 있어요.' },
      { target: '[data-tour="task-stages-save"]', area: ['@footer'], title: '저장하기',
        text: '[N명 저장]을 누르세요. [되돌리기]는 저장 전으로 돌려요.', sub: '숙제를 확인한 학생은 ‘완료 가능’으로 바꿔 주면 학생이 직접 완료하고 보상을 받아요.',
        warn: '저장하면 학생 화면에 바로 반영돼요. ‘완료’로 바꿀 때는 보상을 줄지 물어봐요.' },
    ],
  },
  {
    id: '6-1',
    title: 'QR로 화폐 지급 · 회수하기',
    goal: '금액을 정하고 학생 QR을 찍으면 바로 주거나 거둬요. 모두 거래 내역에 남아요.',
    steps: [
      { tab: 'currency', target: '[aria-label="지급 또는 회수"]', area: ['[data-tour="currency-mode"]'], title: '지급 또는 회수',
        text: '[지급] 또는 [회수]를 고르세요.' },
      { tab: 'currency', target: '#currency-amount', focus: true, title: '금액',
        text: '**금액**을 적으세요. 아래 [+10] [+50] … 버튼으로 빠르게 더할 수 있어요.', sub: '[초기화]는 0으로 돌려요.' },
      { tab: 'currency', target: '[data-tour="currency-start"]', area: ['@target'], title: 'QR 찍기',
        text: '[QR 인식 시작]을 누르고, 창에 적힌 금액과 내용을 확인한 뒤 학생 QR을 찍으세요.', sub: '여러 학생에게 같은 금액을 줄 때는 연달아 찍으면 돼요.',
        warn: 'QR을 찍는 즉시 처리돼요. 회수할 금액이 잔액보다 크면 잔액이 음수가 돼요.' },
    ],
  },
  {
    id: '9-1',
    title: '매점 · 은행 화면 열고 공유하기',
    goal: '바로가기에서 학생 화면을 새 탭으로 열거나, 주소·QR 포스터로 다른 기기에 보내요.',
    steps: [
      { target: '[data-tour="sidebar-shortcuts"] a[href]', area: ['[data-tour="sidebar-shortcuts"]'], title: '바로가기',
        text: '[매점 열기] · [은행 열기]는 이 컴퓨터에서 학생 화면을 새 탭으로 열어요. 오른쪽 공유 버튼은 다른 기기에서 열 수 있게 주소와 QR을 보여 줘요.',
        missing: '바로가기는 넓은 화면(컴퓨터)의 왼쪽에 있어요. 좁은 화면에서는 맨 위의 [공유] 버튼을 쓰세요.' },
      { target: ['[aria-label="은행 공유"]', '[aria-label="공유"]'], area: [{ closest: '.flex' }], title: '공유 창 열기',
        text: '은행 옆 **공유** 버튼을 누르세요.', next: { wait: '[aria-label="공유할 페이지"]' }, advanceWhen: '[aria-label="공유할 페이지"]' },
      { target: '[aria-label="공유할 페이지"]', area: ['@target'], title: '공유할 화면', text: '공유할 화면을 고르세요: **매점 · 은행 · 관리자 페이지**',
        sub: '관리자 페이지 주소는 함께 관리하는 선생님에게만 보내요.' },
      { target: '[data-tour="share-copy"]', area: ['[data-tour="share-address"]'], title: '주소 보내기', text: '[주소 복사]로 주소를 복사해 메신저 등으로 보내요.' },
      { target: '[data-tour="share-pdf"]', area: ['@footer'], title: 'QR 포스터',
        text: '[PDF로 저장] · [이미지로 저장]으로 QR 포스터를 만들어 교실에 붙여요.', sub: '학생이 휴대폰·태블릿 카메라로 찍으면 화면이 바로 열려요.' },
    ],
  },
];

export const tutorialById = (id: string) => TUTORIALS.find((tutorial) => tutorial.id === id) ?? null;

/** The guide's table of contents (admin chapters); a section with a tutorial can be started. */
export const TUTORIAL_CHAPTERS: ReadonlyArray<Readonly<{ no: number; title: string; items: ReadonlyArray<readonly [string, string]> }>> = [
  { no: 1, title: '시작하기', items: [['1-1', '내 학급 열기'], ['1-2', '관리자 화면 둘러보기']] },
  { no: 2, title: '학급 설정', items: [['2-1', '매점·은행 이름과 화폐 단위 정하기'], ['2-2', '화면 색과 글꼴 바꾸기']] },
  { no: 3, title: '학생 관리', items: [['3-1', '학생 한 명씩 추가하기'], ['3-2', '엑셀로 여러 학생 한꺼번에 추가하기'], ['3-3', '학생 정보 고치기 · 이용 멈추기 · 삭제하기'],
    ['3-4', '여러 학생을 골라 한꺼번에 처리하기'], ['3-5', '학생 QR 카드 인쇄하기'], ['3-6', '보관함에 아이템 넣기 · 사용 처리하기']] },
  { no: 4, title: '매점 관리', items: [['4-1', '매점에 상품 추가하기'], ['4-2', '상품 고치기 · 판매 멈추기 · 지우기'], ['4-3', '할인 행사 만들기'], ['4-4', '행사 고치기 · 끄기 · 지우기']] },
  { no: 5, title: '과제 관리', items: [['5-0', '과제 단계 이해하기'], ['5-1', '새 과제 만들기'], ['5-2', '반복 과제 정하기'], ['5-3', '학생에게 과제 내주기'], ['5-4', '학생 단계 바꾸기 · 현황 보기'],
    ['5-5', 'QR로 과제 단계 바꾸기'], ['5-6', '여러 과제를 골라 한꺼번에 처리하기'], ['5-7', '과제를 패들렛 게시판과 연결하기'],
    ['5-8', '패들렛 글이 어떻게 반영됐는지 보기'], ['5-9', '여러 과제를 한 게시판에 연결하기']] },
  { no: 6, title: '화폐와 거래 내역', items: [['6-1', 'QR로 화폐 지급 · 회수하기'], ['6-2', '거래 내역 확인하고 취소하기']] },
  { no: 7, title: '펫 키우기', items: [['7-1', '펫 키우기 켜고 성장 정하기'], ['7-2', '먹이와 이용 시간 정하기'], ['7-3', '졸업 보상과 꾸미기 상점 정하기'], ['7-4', '학생 펫 살펴보고 성장 조정하기']] },
  { no: 8, title: '나무 키우기', items: [['8-1', '나무 키우기 켜고 목표 정하기'], ['8-2', '수확 보상과 예상 기간 정하기'], ['8-3', '양분 조정하고 참여 살펴보기']] },
  { no: 9, title: '화면 열기와 공유', items: [['9-1', '매점 · 은행 화면 열고 공유하기']] },
];

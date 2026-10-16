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
  /** Pressing the target moves on, even when what it opens is open already (a menu, a tab). */
  clickMovesOn?: boolean;
  /** Said when the target is not on the screen (a menu only on wide screens, …). */
  missing?: string;
  /** The step only applies when this is on the screen (a field shown by a switch); otherwise it is passed over. */
  skipUnless?: string;
  /** The tab the target sits behind: clicked once when the target is not on the screen (going back, too). */
  reveal?: string;
  /** Only to look at (a tour, an explanation): no arrow, and the lit unit does not take clicks. */
  peek?: boolean;
  /** Not asked for (an option to use only if needed): no arrow, but the lit unit stays usable. */
  look?: boolean;
  /** The target goes to another page; the tutorial goes on there from the next step. */
  opensPage?: 'classes';
}>;

export type Tutorial = Readonly<{
  id: string;
  title: string;
  goal: string;
  /** Needs the stage-ledger task screen (PostgreSQL classes). */
  ledger?: boolean;
  /** The tutorial to offer when this one is done (default: the next one in the table of contents). */
  then?: string;
  steps: readonly TutorialStep[];
}>;

const dialog = (name: string) => `[role="dialog"][aria-label="${name}"]`;
const TOOLBAR = '[role="toolbar"][aria-label="선택 항목 작업"]';
const TASK_SHEET = '[role="dialog"][aria-label$=" 과제 편집"]';
const STUDENT_SHEET = '[role="dialog"][aria-label$=" 학생 편집"]';
const PRODUCT_SHEET = '[role="dialog"][aria-label$=" 상품 편집"]';
const NO_STUDENTS = '먼저 학생을 등록해 주세요. 도움말 3-1에서 따라 할 수 있어요.';
const NO_TASKS = '먼저 과제를 만들어 주세요. 도움말 5-1에서 따라 할 수 있어요.';

/** The admin menu, as the teacher sees it: its word and the object particle that follows it. */
const MENU: Readonly<Record<AdminTab, readonly [string, '을' | '를']>> = {
  home: ['홈', '을'], students: ['학생', '을'], products: ['매점', '을'], tasks: ['과제', '를'], pets: ['펫 키우기', '를'],
  tree: ['나무 키우기', '를'], currency: ['지급·회수', '를'], transactions: ['거래 내역', '을'], settings: ['설정', '을'],
};

/**
 * Every tutorial starts by choosing its screen in the menu, so the teacher learns where it is.
 * `{menu}` is said as 왼쪽 메뉴 or 맨 위 메뉴, by the screen width. Pressing it moves on even if
 * that screen is open already.
 */
const menuStep = (tab: AdminTab, text: string, sub?: string): TutorialStep => ({
  target: `#admin-tab-${tab}`, area: ['[data-testid="admin-tabs"]'], title: '메뉴 고르기', text, ...(sub ? { sub } : {}),
  next: { click: `#admin-tab-${tab}`, wait: `#admin-panel-${tab}` }, advanceWhen: `#admin-panel-${tab}`, clickMovesOn: true,
});

/** `${what} 왼쪽 메뉴의 [학생]에서 해요. [학생]을 누르세요.` */
const menu = (tab: AdminTab, what: string, verb = '해요'): TutorialStep => {
  const [label, particle] = MENU[tab];
  return menuStep(tab, `${what} **{menu}**의 [${label}]에서 ${verb}. [${label}]${particle} 누르세요.`);
};

/** Opens a student's editor from the 학생 list. */
const openStudent = (text: string): TutorialStep => ({
  tab: 'students', target: '[data-testid="student-row"] button[aria-label$=" 편집"]', area: [{ closest: '[data-testid="student-row"]' }], title: '학생 고르기',
  text, sub: '[다음]을 누르면 맨 위 학생으로 보여 드려요.', next: { wait: STUDENT_SHEET }, advanceWhen: STUDENT_SHEET, missing: NO_STUDENTS,
});

/** Opens a task's editor from the 과제 list. */
const openTask = (text: string): TutorialStep => ({
  tab: 'tasks', target: '[data-testid="task-row"] button[aria-label$=" 과제 편집"]', area: [{ closest: '[data-testid="task-row"]' }], title: '과제 고르기',
  text, sub: '[다음]을 누르면 맨 위 과제로 보여 드려요.', next: { wait: TASK_SHEET }, advanceWhen: TASK_SHEET, missing: NO_TASKS,
});

const taskTab = (tab: 'repeat' | 'students' | 'padlet') => `${TASK_SHEET} [data-tour="sheet-tab-${tab}"]`;

/** Switches the open task editor to one of its tabs. */
const openTaskTab = (tab: 'repeat' | 'students' | 'padlet', label: string, wait: string): TutorialStep => ({
  target: taskTab(tab), area: [{ closest: '[role="tablist"]' }], title: `${label} 탭`, text: `창 위의 [${label}] 탭을 누르세요.`,
  next: { click: taskTab(tab), wait }, advanceWhen: wait, clickMovesOn: true,
});

/** Picks rows of a list by their check boxes, which brings up the selection bar. */
const pickRows = (tab: AdminTab, row: string, text: string, missing: string): TutorialStep => ({
  tab, target: `${row} input[type="checkbox"]`, area: [{ closest: row }], title: '체크해서 고르기',
  text, sub: '맨 위 체크 상자는 전체 선택이에요.', next: { wait: TOOLBAR }, advanceWhen: TOOLBAR, missing,
});

const petTab = (id: string, label: string, wait: string): TutorialStep => ({
  tab: 'pets', target: `#pet-tab-${id}`, area: [{ closest: '[role="tablist"]' }], title: `${label} 탭`,
  text: `[${label}] 탭을 누르세요.`, sub: '탭마다 정한 뒤 맨 아래 [설정 저장]으로 한꺼번에 저장해요.',
  next: { click: `#pet-tab-${id}`, wait }, advanceWhen: wait, clickMovesOn: true,
});

const PET_SAVE: TutorialStep = {
  tab: 'pets', target: '[data-tour="pet-save"]', area: ['[data-tour="pet-save-bar"]'], title: '저장하기',
  text: '[설정 저장]을 누르세요. 바꾼 것이 없으면 버튼이 흐려요.', warn: '저장하면 학생 화면에 바로 반영돼요.',
};

const TREE_SAVE: TutorialStep = {
  tab: 'tree', target: '[data-tour="tree-save"]', area: ['[data-tour="tree-save-bar"]'], title: '저장하기',
  text: '[설정 저장]을 누르세요. 아직 나무를 심지 않았다면 [이 설정으로 시작하기]를 누르면 씨앗이 심어져요.',
  warn: '누르면 학생 화면에 바로 반영돼요.',
};

const PADLET_RULES: TutorialStep = {
  target: '[data-tour="padlet-rules"]', area: ['@target'], peek: true, title: '세는 규칙', text: '글을 세는 **규칙**을 확인하세요.',
  sub: '학생이 ‘미완료’가 된 뒤 마감 전까지 올린 글만, 글 하나는 한 번만 세요. 학생 이름은 글쓴이 이름에서 먼저 찾고, 없으면 글 제목에서 찾아요.',
};

export const TUTORIALS: readonly Tutorial[] = [
  {
    id: '0-1',
    title: '딴쌤 클래스 한 바퀴 둘러보기',
    goal: '처음 쓰는 선생님을 위해 꼭 필요한 화면을 메뉴에서 하나씩 찾아가며 둘러봐요. 둘러보기만 하니 아무것도 바뀌지 않아요.',
    then: '2-1',
    steps: [
      { target: '[data-testid="admin-tabs"]', area: ['@target'], peek: true, title: '처음 오셨나요?',
        text: '**딴쌤 클래스**는 학급 화폐로 교실 매점과 은행을 운영해요. 선생님은 이 **관리자 화면**에서 학생, 상품, 과제를 정하고, 학생은 **QR 카드**로 매점에서 사고 은행에서 잔액과 과제를 봐요.',
        sub: '화면은 **{menu}**에서 골라요. 꼭 필요한 화면을 차례로 찾아가 볼게요.' },
      menuStep('students', '먼저 **학생**을 등록해요. **{menu}**의 [학생]을 누르세요.'),
      { tab: 'students', target: '[data-tour="student-add"]', area: ['@header'], peek: true, title: '학생 등록',
        text: '[학생 추가]로 한 명씩, [엑셀로 일괄 추가]로 여러 명을 한꺼번에 등록해요.', sub: '번호는 학생을 구분하는 고유 번호예요. 따라 하기: 도움말 3-1, 3-2' },
      { tab: 'students', target: ['[aria-label="전체 학생 선택"]', '[data-tour="student-add"]'], area: ['[data-testid="student-header-row"]'], peek: true, title: 'QR 카드',
        text: '학생마다 **QR 카드**를 인쇄해 나눠 줘요. 매점에서 결제하고 은행에 들어가는 열쇠예요.', sub: '학생을 체크하면 화면 아래에 [QR 카드 발급]이 나와요. 따라 하기: 도움말 3-5' },
      menuStep('products', '다음은 매점에서 팔 **상품**이에요. **{menu}**의 [매점]을 누르세요.'),
      { tab: 'products', reveal: '#admin-store-tab-inventory', target: '[data-tour="product-add"]', area: ['@header'], peek: true, title: '상품 등록',
        text: '[상품 추가]로 매점에서 팔 상품을 올려요. 간식, 학용품 같은 **실물 상품**이 대부분이에요.',
        sub: '자리 바꾸기권처럼 실물이 없는 상품은 디지털 상품으로 만들 수 있어요. 할인 행사는 [행사 관리] 탭에서 만들어요. 따라 하기: 도움말 4-1' },
      menuStep('tasks', '학생이 하고 보상을 받을 일은 **과제**로 만들어요. **{menu}**의 [과제]를 누르세요.'),
      { tab: 'tasks', target: '[data-tour="task-new"]', area: ['@header'], peek: true, title: '과제',
        text: '[새 과제]로 숙제, 청소 당번처럼 학생이 하고 **보상**을 받을 일을 만들어요.',
        sub: '학생마다 **미부여 → 미완료 → 완료 가능 → 완료** 단계가 있어요. 해 온 학생을 ‘완료 가능’으로 바꿔 주면 학생이 은행에서 직접 완료하고 보상을 받아요. 따라 하기: 도움말 5-0, 5-1' },
      menuStep('currency', '칭찬이나 벌금으로 화폐를 바로 주거나 거둘 때는 **{menu}**의 [지급·회수]를 누르세요.'),
      { tab: 'currency', target: '[data-tour="currency-start"]', area: ['[data-tour="currency-mode"]', '@target'], peek: true, title: '지급, 회수',
        text: '[지급] 또는 [회수]와 금액을 정하고 [QR 인식 시작]을 눌러 학생 QR을 찍어요.', sub: '찍는 즉시 잔액이 바뀌고 거래 내역에 남아요. 따라 하기: 도움말 6-1' },
      menuStep('transactions', '돈이 오간 기록은 **{menu}**의 [거래 내역]에서 봐요. [거래 내역]을 누르세요.'),
      { tab: 'transactions', target: '[data-tour="tx-stats"]', area: ['@target'], peek: true, title: '거래 내역',
        text: '매점 결제, 과제 보상, 지급과 회수가 모두 **거래 내역**에 남아요.', sub: '잘못된 결제는 그 거래를 취소해 되돌려요. 따라 하기: 도움말 6-2' },
      { target: ['[data-tour="sidebar-shortcuts"]', '[data-tour="header-shortcuts"]'], area: ['@target'], peek: true, title: '학생 화면 열기',
        text: '학생이 쓰는 화면은 둘이에요. **매점**은 교실 컴퓨터나 태블릿에 띄워 두고 학생이 QR 카드를 찍어 사요. **은행**은 학생이 QR로 들어가 잔액과 과제를 봐요.',
        sub: '**바로가기**에서 매점, 은행을 열고, 공유 버튼으로 주소와 QR 포스터를 받아요. 따라 하기: 도움말 9-1' },
      { target: '#admin-tab-pets', area: ['#admin-tab-pets', '#admin-tab-tree'], peek: true, title: '골라 쓰는 기능',
        text: '**펫 키우기, 나무 키우기**는 원할 때 켜는 기능이에요. 학생이 과제를 하면 펫이 자라고 반 나무에 양분이 쌓여요.', sub: '따라 하기: 도움말 7-1, 8-1' },
      menuStep('home', '마지막으로 **{menu}**의 [홈]을 누르세요.', '홈에서는 학급 현황을 한눈에 보고 자주 쓰는 일을 바로 시작해요.'),
      { tab: 'home', target: '[data-testid="tutorial-home-card"]', area: ['@target'], peek: true, title: '이제 해 볼 차례',
        text: '기능마다 [도움말 목록]에서 골라 실제 화면에서 따라 해요. 다른 화면에서는 바로가기의 [도움말](휴대폰은 맨 위 물음표 버튼)로 열어요.',
        sub: '이 순서를 추천해요: 이름과 화폐 단위 정하기(2-1) → 학생 추가(3-1) → QR 카드 인쇄(3-5) → 상품 추가(4-1) → 과제 만들기(5-1)' },
    ],
  },
  {
    id: '1-1',
    title: '내 학급 열기',
    goal: '‘내 학급’ 화면에서 학급을 골라 관리자 화면이나 매점, 은행으로 들어가요.',
    steps: [
      { target: 'a[aria-label="딴쌤 홈"]', area: ['@parent'], opensPage: 'classes', title: '내 학급으로 가기',
        text: '맨 위 왼쪽의 **딴쌤 로고**를 누르면 **내 학급** 목록으로 가요. 로고를 누르세요.', sub: '옆의 [클래스]를 눌러도 같은 곳으로 가요. 컴퓨터에서는 왼쪽 아래 [메인 화면으로]도 돼요.',
        next: { click: 'a[aria-label="딴쌤 홈"]', wait: 'a[aria-label="새 학급"]' } },
      { target: 'a[aria-label="새 학급"]', area: [{ closest: 'section' }], peek: true, title: '내 학급',
        text: '**내 학급**에는 내가 만들었거나 함께 관리하는 학급이 모여 있어요.', sub: '새 학급은 [새 학급 만들기]로 만들어요.' },
      { target: 'section[aria-label="학급 현황"]', area: ['@target'], peek: true, title: '학급 현황',
        text: '**전체 학급, 사용 중인 학급, 등록된 학생** 수를 한눈에 봐요.' },
      { target: '[aria-label="학급 분류"]', area: ['@parent'], look: true, title: '학급 찾기',
        text: '[전체], [사용 중], [준비 중], [휴지통]으로 나눠 보고, 이름으로 검색하거나 정렬해요.', sub: '삭제한 학급은 **휴지통**에서 복원하거나, [완전히 삭제]로 모든 자료를 지울 수 있어요. 완전히 삭제한 학급은 되돌릴 수 없어요.' },
      { target: '[aria-label$=" 이름 변경"]', area: ['@parent'], skipUnless: '[aria-label$=" 이름 변경"]', peek: true, title: '학급 관리',
        text: '학급 소유자는 [이름 변경], [복제], [삭제]를 쓸 수 있어요. [삭제]한 학급은 휴지통으로 옮겨져요.',
        sub: '복제하면 설정, 학생 명단, 상품, 과제, 행사를 새 학급에 가져와요. 잔액은 0에서 시작하고, 과제와 행사는 꺼진 채로 복제돼요.' },
      { target: 'a[aria-label$=" 학급으로 이동"]', area: ['@parent'], peek: true, title: '학생 화면 열기',
        text: '[매점], [은행]은 학생이 쓰는 화면을 이 기기에서 열어요.', sub: '카드 아래의 **학생 QR 출력**, **매점 주소 복사**도 여기서 해요.',
        missing: '사용 중인 학급이 없어요. [새 학급 만들기]로 먼저 학급을 만드세요.' },
      { target: 'a[aria-label$=" 관리자 페이지"]', area: [{ closest: 'li' }], title: '관리자 페이지로',
        text: '[관리자 페이지]를 누르세요. 이 학급을 관리하는 화면으로 들어가요.', sub: '관리자 화면 맨 위의 딴쌤 로고를 누르면 언제든 이 목록으로 돌아와요.',
        missing: '사용 중인 학급이 없어요. [새 학급 만들기]로 먼저 학급을 만드세요.' },
    ],
  },
  {
    id: '1-2',
    title: '관리자 화면 둘러보기',
    goal: '메뉴, 홈 화면의 현황 카드, 바로가기를 차례로 살펴봐요.',
    steps: [
      menuStep('home', '관리할 화면은 **{menu}**에서 골라요. 홈 화면을 보려면 [홈]을 누르세요.',
        '메뉴에는 홈, 학생, 매점, 과제, 펫 키우기, 나무 키우기, 지급·회수, 거래 내역, 설정이 있어요.'),
      { tab: 'home', target: '[data-tour="home-stats"]', area: ['@target'], peek: true, title: '오늘의 학급',
        text: '**학생 수, 잔액 합계, 판매 중인 상품, 진행 중인 과제**를 한눈에 봐요.', sub: '카드 아래 작은 글씨로 비활성 학생, 음수 잔액, 전체 재고도 알려 줘요.' },
      { tab: 'home', target: '[data-tour="home-quick"]', area: ['@target'], peek: true, title: '자주 쓰는 일',
        text: '**화폐 지급·회수**, **QR로 과제 부여**로 바로 시작하고, **매점 열기**, **은행 열기**로 학생 화면을 새 탭에 열어요.' },
      { tab: 'home', target: '[data-tour="home-start"]', area: ['@target'], skipUnless: '[data-tour="home-start"]', peek: true, title: '학급 시작하기',
        text: '**학생 등록 → 상품 등록 → 과제 만들기**를 마치면 학생들이 매점과 은행을 쓸 수 있어요.', sub: '끝낸 일에는 ‘완료’가 붙고, 셋 다 끝내면 이 카드는 사라져요.' },
      { tab: 'home', target: '[data-tour="home-progress"]', area: ['@target'], peek: true, title: '과제 진행 현황',
        text: '과제마다 **완료한 학생 수**를 막대로 봐요.', sub: '과제를 누르면 그 과제의 학생 현황이 열려요.' },
      { tab: 'home', target: '[data-tour="home-check"]', area: ['@target'], peek: true, title: '확인이 필요한 항목',
        text: '**잔액이 음수인 학생**과 **재고가 3개 이하인 상품**을 알려 줘요.' },
      { target: ['[data-tour="sidebar-shortcuts"]', '[data-tour="header-shortcuts"]'], area: ['@target'], peek: true, title: '바로가기',
        text: '학생용 **매점, 은행** 화면을 열거나 공유하고, 학생 QR 카드를 인쇄해요.', sub: '컴퓨터에서는 메뉴 아래, 휴대폰에서는 화면 맨 위에 있어요. 따라 하기: 도움말 9-1' },
      { target: 'a[aria-label="딴쌤 홈"]', area: ['@parent'], skipUnless: 'a[aria-label="딴쌤 홈"]', peek: true, title: '내 학급으로',
        text: '맨 위의 **딴쌤 로고**나 [클래스]를 누르면 내 학급 목록으로 돌아가요.' },
      { tab: 'home', target: '[data-testid="tutorial-home-card"]', area: ['@target'], peek: true, title: '도움말',
        text: '배우고 싶은 기능이 생기면 홈의 [도움말 목록]에서 언제든 골라 따라 해요.', sub: '다른 화면에서는 바로가기의 [도움말](휴대폰은 맨 위 물음표 버튼)로 열어요.' },
    ],
  },
  {
    id: '2-1',
    title: '매점, 은행 이름과 화폐 단위 정하기',
    goal: '학생 화면 맨 위의 이름과, 학급에서 쓰는 돈의 단위를 바꿔요.',
    steps: [
      menu('settings', '매점, 은행 이름과 화폐 단위는'),
      { tab: 'settings', target: '#settings-app-title', focus: true, title: '매점 이름',
        text: '**매점 이름**을 적으세요. 매점 화면 맨 위에 보여요.', sub: '예: 6학년 3반 매점, 햇살 가게' },
      { tab: 'settings', target: '#settings-bank-title', focus: true, title: '은행 이름',
        text: '**은행 이름**을 적으세요. 은행 화면 맨 위에 보여요.', sub: '예: 6학년 3반 은행' },
      { tab: 'settings', target: '#settings-currency', focus: true, title: '화폐 단위',
        text: '**화폐 단위**를 적으세요. 모든 금액 뒤에 붙어요.', sub: '예: 원, 별, 포인트 — 1,000원이 1,000별로 바뀌어요.' },
      { tab: 'settings', target: '[data-tour="settings-save"]', area: ['[data-tour="settings-save-bar"]'], title: '저장하기',
        text: '[설정 저장]을 누르세요.', sub: '‘저장하지 않은 변경 사항이 있어요’가 보이면 아직 저장 전이에요. 바꾼 것이 없으면 버튼이 흐려요.',
        warn: '저장하면 매점, 은행 화면에 바로 반영돼요.' },
    ],
  },
  {
    id: '2-2',
    title: '글꼴 바꾸기',
    goal: '학생이 보는 매점, 은행 화면의 글꼴을 정해요.',
    steps: [
      menu('settings', '글꼴은'),
      { tab: 'settings', target: '#settings-font', area: ['@field', '[data-tour="settings-font-preview"]'], title: '글꼴',
        text: '**글꼴**을 고르세요. 아래 글자로 어떻게 보일지 확인해요.' },
      { tab: 'settings', target: '[data-tour="settings-save"]', area: ['[data-tour="settings-save-bar"]'], title: '저장하기',
        text: '[설정 저장]을 누르세요. 바꾼 것이 없으면 버튼이 흐려요.', warn: '저장하면 매점, 은행 화면에 바로 반영돼요.' },
    ],
  },
  {
    id: '3-1',
    title: '학생 한 명씩 추가하기',
    goal: '번호, 이름, 처음 잔액을 넣어 학생을 한 명 등록해요.',
    steps: [
      menu('students', '학생 등록은'),
      { tab: 'students', target: '[data-tour="student-add"]', area: ['@header'], title: '추가 창 열기',
        text: '[학생 추가]를 누르세요. 오른쪽에 입력 창이 열려요.', next: { wait: '#new-student-id' }, advanceWhen: '#new-student-id' },
      { target: '#new-student-id', focus: true, title: '번호',
        text: '**번호**를 적으세요. 학생을 구분하는 고유 번호예요.', sub: '반 안에서 겹치면 안 돼요. 예: 01, 6301' },
      { target: '#new-student-name', focus: true, title: '이름',
        text: '**이름**을 적으세요.', warn: '만 14세 미만 학생의 실명은 학부모(법정대리인) 동의를 받은 뒤에 적어 주세요. 동의 전이면 별명을 써요.' },
      { target: '#new-student-balance', focus: true, title: '처음 잔액',
        text: '**처음 잔액**을 적으세요.', sub: '비워 두면 0이에요. 음수로도 시작할 수 있어요.' },
      { target: '[data-tour="student-create"]', area: ['@footer'], title: '추가하기',
        text: '[새 학생 추가]를 누르세요. 명단에 들어가요.', warn: '누르면 학생이 실제로 추가돼요. 추가한 학생의 번호는 지워도 다시 쓸 수 없어요.' },
    ],
  },
  {
    id: '3-2',
    title: '엑셀로 여러 학생 한꺼번에 추가하기',
    goal: '양식 파일에 학생 명단을 채워 올리고, 미리 보기로 확인한 뒤 한꺼번에 추가해요.',
    steps: [
      menu('students', '학생 등록은'),
      { tab: 'students', target: '[aria-label="학생 양식 다운로드"]', area: ['@header'], title: '양식 받기',
        text: '[양식 다운로드]를 눌러 엑셀 양식을 받으세요.', sub: '받은 ‘학생 명단 양식.xlsx’에 학생 번호, 이름, 처음 잔액을 한 줄에 한 명씩 채워 저장해요.',
        missing: '이 학급에서는 엑셀로 추가할 수 없어요. 도움말 3-1처럼 한 명씩 추가해 주세요.' },
      { tab: 'students', target: '[aria-label="학생 엑셀로 일괄 추가"]', area: ['@header'], title: '파일 올리기',
        text: '[엑셀로 일괄 추가]를 누르고 채운 파일을 고르세요.', sub: '고르면 바로 파일을 검사해 미리 보기 창을 열어요.',
        advanceWhen: dialog('엑셀로 학생 추가'), missing: '이 학급에서는 엑셀로 추가할 수 없어요. 도움말 3-1처럼 한 명씩 추가해 주세요.' },
      { target: `${dialog('엑셀로 학생 추가')} table`, area: [`${dialog('엑셀로 학생 추가')} > div`], peek: true, title: '미리 보기',
        text: '추가할 학생을 **미리 보기** 표로 확인하세요.', sub: '오류가 있는 줄은 이유가 함께 나오고 추가되지 않아요. 고친 파일은 [다른 파일 선택]으로 다시 올려요.',
        missing: '파일을 고르면 미리 보기 창이 열려요. 창이 없으면 [이전]으로 돌아가 파일을 다시 고르세요.' },
      { target: `${dialog('엑셀로 학생 추가')} [data-tour="bulk-import-commit"]`, area: ['@footer'], title: '추가하기',
        text: '[학생 N명 추가]를 누르세요. 명단에 들어가요.', warn: '누르면 학생이 실제로 추가돼요. 추가한 학생의 번호는 지워도 다시 쓸 수 없어요.',
        missing: '파일을 고르면 미리 보기 창이 열려요. 창이 없으면 [이전]으로 돌아가 파일을 다시 고르세요.' },
    ],
  },
  {
    id: '3-3',
    title: '학생 정보 고치기, 이용 멈추기, 삭제하기',
    goal: '학생 편집 창에서 이름과 잔액을 고치고, 이용을 멈추거나 학생을 지워요.',
    steps: [
      menu('students', '학생 정보 고치기는'),
      openStudent('고칠 학생의 **이름**을 누르세요. 오른쪽에 편집 창이 열려요.'),
      { target: '#student-sheet-name', focus: true, title: '이름', text: '**이름**을 고치세요.' },
      { target: '#student-sheet-balance', focus: true, look: true, title: '잔액',
        text: '**잔액**을 직접 고칠 수 있어요.', sub: '직접 고치면 거래 내역 없이 잔액만 바뀌어요. 보상이나 벌금은 [지급·회수] 메뉴를 쓰세요.' },
      { target: `${STUDENT_SHEET} [role="switch"][aria-label$=" 활성"]`, look: true, title: '이용 멈추기',
        text: '**활성 학생**을 끄면 이 학생은 매점과 은행을 쓸 수 없어요.', sub: '전학 간 학생처럼 기록은 남기고 이용만 멈출 때 써요. 다시 켜면 다시 쓸 수 있어요.' },
      { target: '[data-tour="student-qr"]', area: ['@parent'], peek: true, title: 'QR 카드', text: '[QR 카드]로 이 학생의 카드만 다시 인쇄해요.' },
      { target: `${STUDENT_SHEET} [aria-label$=" 학생 삭제"]`, area: ['@footer'], peek: true, title: '삭제하기',
        text: '[삭제]는 학생을 명단에서 지워요. 누르면 한 번 더 물어봐요.',
        warn: '지운 학생은 되돌릴 수 없고, 그 번호는 다시 쓸 수 없어요. 거래 기록은 남아요. 이용만 멈추려면 삭제 대신 **활성 학생**을 끄세요.' },
      { target: '[data-tour="student-save"]', area: ['@footer'], title: '저장하기',
        text: '고친 뒤 [저장]을 누르세요. 바꾼 것이 없으면 버튼이 흐려요.', warn: '저장하면 매점, 은행에 바로 반영돼요.' },
    ],
  },
  {
    id: '3-4',
    title: '여러 학생을 골라 한꺼번에 처리하기',
    goal: '체크한 학생들의 잔액을 한꺼번에 바꾸고, QR 카드 인쇄, 보관함 넣기, 삭제도 한 번에 해요.',
    steps: [
      menu('students', '학생 관리는'),
      pickRows('students', '[data-testid="student-row"]', '학생 줄 왼쪽 **체크 상자**로 학생을 고르세요.', NO_STUDENTS),
      { target: TOOLBAR, area: ['@target'], peek: true, title: '작업 막대',
        text: '고르면 아래에 **작업 막대**가 나타나요. 고른 학생 모두에게 할 일을 골라요.',
        sub: '[QR 카드 발급]은 고른 학생의 카드만 인쇄해요. 오른쪽 끝 ✕는 선택을 풀어요.', missing: '학생을 한 명 이상 고르면 작업 막대가 나와요.' },
      { target: '[data-tour="student-bulk-give"]', area: [TOOLBAR], skipUnless: '[data-tour="student-bulk-give"]', peek: true, title: '보관함에 넣기',
        text: '[보관함에 넣기]로 고른 학생 모두에게 같은 아이템을 넣어요.', sub: '디지털 상품은 그대로, 실물 상품은 교환권으로 들어가요. 따라 하기: 도움말 3-6' },
      { target: '[data-tour="student-bulk-delete"]', area: [TOOLBAR], peek: true, title: '삭제',
        text: '[삭제]는 고른 학생을 명단에서 지워요.', warn: '누르면 한 번 더 물어봐요. 지운 학생은 되돌릴 수 없어요.' },
      { target: '[data-tour="student-bulk-balance"]', area: [TOOLBAR], title: '잔액 바꾸기',
        text: '[잔액 변경]을 누르세요.', next: { wait: dialog('잔액 한꺼번에 바꾸기') }, advanceWhen: dialog('잔액 한꺼번에 바꾸기'),
        missing: '학생을 한 명 이상 고르면 작업 막대가 나와요.' },
      { target: '[aria-label="선택 학생 작업"]', area: ['@parent'], title: '방법',
        text: '**더하기, 빼기, 이 금액으로 맞추기** 중에서 고르세요.', sub: '맞추기는 고른 학생 모두의 잔액을 같은 금액으로 바꿔요.' },
      { target: '#bulk-balance-amount', focus: true, title: '금액', text: '**금액**을 적으세요.' },
      { target: '[data-tour="bulk-balance-apply"]', area: ['@footer'], title: '적용하기',
        text: '[N명에게 적용]을 누르세요.', warn: '누르면 고른 학생의 잔액이 바로 바뀌어요.' },
    ],
  },
  {
    id: '3-5',
    title: '학생 QR 카드 인쇄하기',
    goal: 'QR 카드는 학생의 결제 수단이자 은행 로그인 열쇠예요. 인쇄해서 잘라 나눠 줘요.',
    steps: [
      menu('students', 'QR 카드 인쇄는'),
      { target: 'a[href$="/admin/student-qrs"]', area: ['[data-tour="sidebar-shortcuts"]'], skipUnless: 'a[href$="/admin/student-qrs"]', title: '반 전체 인쇄',
        text: '반 전체는 왼쪽 바로가기의 [학생 QR 인쇄]로 한 번에 뽑아요. 새 탭에 활성 학생 모두의 카드가 나오면 [QR 카드 인쇄하기]를 누르세요.',
        sub: '그대로 인쇄하면 전에 나눠 준 카드도 계속 써요. 모두 새 카드로 바꾸려면 먼저 [새로 발급]을 누르세요. [다음]을 누르면 학생을 골라 뽑는 방법을 보여 드려요.' },
      { tab: 'students', target: '[data-testid="student-row"] input[type="checkbox"]', area: ['[data-testid="student-header-row"]', { closest: '[data-testid="student-row"]' }], title: '학생 고르기',
        text: '인쇄할 학생을 줄 왼쪽 **체크 상자**로 고르세요. 맨 위 체크 상자를 누르면 반 전체를 골라요.', sub: '잃어버린 카드를 바꿔 줄 때도 이렇게 해요.',
        next: { wait: '[data-tour="student-qr-bulk"]' }, advanceWhen: '[data-tour="student-qr-bulk"]', missing: NO_STUDENTS },
      { target: '[data-tour="student-qr-bulk"]', area: [{ closest: '[role="toolbar"]' }], title: '고른 학생만 인쇄',
        text: '[QR 카드 발급]을 누르세요. 고른 학생의 카드가 창에 나와요.',
        next: { wait: dialog('선택 학생 QR 발급') }, advanceWhen: dialog('선택 학생 QR 발급') },
      { target: `${dialog('선택 학생 QR 발급')} [data-tour="student-qr-reissue"]`, area: ['@footer'], title: '그대로 인쇄, 새로 발급',
        text: '지금 카드를 그대로 쓰려면 [인쇄]를 누르세요. 잃어버린 카드는 [새로 발급]을 누른 뒤 인쇄해요.',
        sub: '새로 발급하면 그 학생이 전에 받은 카드는 더 이상 쓸 수 없어요.',
        warn: 'QR 카드만 있으면 매점 결제와 은행 로그인이 돼요. 친구에게 빌려주거나 사진으로 찍어 공유하지 않도록 지도해 주세요.',
        missing: '[QR 카드 발급]을 누르면 카드 창이 열려요. 창을 닫았다면 [이전]으로 돌아가 다시 여세요.' },
    ],
  },
  {
    id: '3-6',
    title: '보관함에 아이템 넣기, 사용 처리하기',
    goal: '학생 편집 창의 보관함에서 아이템을 넣어 주고, 학생이 쓴 쿠폰을 ‘사용함’으로 처리해요.',
    steps: [
      menu('students', '학생 보관함 관리는'),
      openStudent('보관함을 볼 학생의 **이름**을 누르세요. 오른쪽에 편집 창이 열려요.'),
      { target: '[data-tour="storage-head"]', area: ['@target', '[data-tour="storage-note"]'], peek: true, title: '보관함',
        text: '편집 창 아래 **보관함**에 이 학생이 가진 아이템이 보여요.',
        sub: '[사용 가능], [사용 완료]로 나눠 봐요. 매점에서 산 디지털 상품, 나무 수확, 펫 졸업 보상이 여기에 모여요.',
        missing: '보관함은 학생 편집 창 아래에 있어요. 창을 닫았다면 [이전]으로 돌아가 다시 여세요.' },
      { target: ['[data-tour="storage-give"] select', '[data-tour="storage-give"]'], area: ['[data-tour="storage-give"]'], title: '넣어 주기',
        text: '**넣을 아이템**과 **개수**를 고르고 [넣기]를 누르세요.',
        sub: '디지털 상품은 그대로, 실물 상품은 **교환권**으로 들어가요(학생이 매점에서 그 상품을 살 때 써요). 여러 학생에게는 학생 목록에서 체크한 뒤 [보관함에 넣기]로 한꺼번에 넣어요.',
        warn: '[넣기]를 누르면 학생 보관함에 바로 들어가요.', missing: '[사용 가능]을 누르면 넣기 칸이 보여요.' },
      { target: ['[data-tour="storage-use"]', '[data-tour="storage-revoke"]'], area: [{ closest: 'li' }], skipUnless: '[data-tour="storage"] li', look: true, title: '사용 처리',
        text: '학생이 쿠폰 같은 **소모품**을 쓰면 [사용함]을 누르세요.',
        sub: '잘못 넣은 아이템은 [회수]로 거둬요. 잘못 사용 처리했다면 [사용 완료]에서 [사용 취소]로 되돌려요.',
        warn: '[사용함]은 누르는 즉시 반영돼요. [회수]는 한 번 더 물어봐요.' },
    ],
  },
  {
    id: '3-7',
    title: '모둠 만들고 학생 넣기',
    goal: '학생을 모둠으로 묶어요. 모둠별로 학생을 보고, 딴쌤 보드에서도 모둠 단위로 권한을 줄 수 있어요.',
    steps: [
      menu('students', '모둠은'),
      { target: '[data-tour="student-groups"]', area: ['@target'], title: '모둠 열기',
        text: '위쪽의 [모둠]을 누르세요.', next: { wait: dialog('모둠') }, advanceWhen: dialog('모둠') },
      { target: `${dialog('모둠')} [data-tour="student-group-create"]`, area: ['@target'], title: '모둠 만들기',
        text: '**새 모둠 이름**을 적고 [만들기]를 누르세요. 다 만들었으면 창을 닫으세요.',
        sub: '모둠 이름 옆 ⋯에서 이름을 바꾸거나 지워요. 모둠을 지워도 학생은 그대로예요.',
        missing: '[모둠]을 누르면 창이 열려요. 창을 닫았다면 [이전]으로 돌아가 다시 여세요.' },
      pickRows('students', '[data-testid="student-row"]', '모둠에 넣을 학생을 줄 왼쪽 **체크 상자**로 고르세요.', NO_STUDENTS),
      { target: '[data-tour="student-bulk-group"]', area: [TOOLBAR], title: '모둠 지정',
        text: '[모둠 지정]을 누르세요.', next: { wait: dialog('모둠 지정') }, advanceWhen: dialog('모둠 지정'),
        missing: '학생을 한 명 이상 고르면 작업 막대가 나와요.' },
      { target: `${dialog('모둠 지정')} [role="radiogroup"]`, area: ['@target', '@footer'], title: '모둠 고르기',
        text: '넣을 **모둠**을 고르고 [지정]을 누르세요.', sub: '학생은 모둠 하나에만 들어가요. [모둠 없음]을 고르면 모둠에서 빼요.',
        warn: '쉬게 하거나 지운 학생은 모둠에서 빠져요.' },
      { target: '[aria-label="모둠 거르기"]', area: ['@target'], skipUnless: '[aria-label="모둠 거르기"]', peek: true, title: '모둠별로 보기',
        text: '**모둠 거르기**로 한 모둠의 학생만 볼 수 있어요. 이름 아래에 모둠이 보여요.' },
    ],
  },
  {
    id: '4-1',
    title: '매점에 상품 추가하기',
    goal: '이름, 가격, 재고, 분류를 넣어 매점에 새 상품을 올려요.',
    steps: [
      menu('products', '상품 추가는'),
      { tab: 'products', reveal: '#admin-store-tab-inventory', target: '[data-tour="product-add"]', area: ['@header'], title: '추가 창 열기',
        text: '[상품 추가]를 누르세요. 오른쪽에 입력 창이 열려요.', next: { wait: '#new-product-name' }, advanceWhen: '#new-product-name' },
      { target: '#new-product-image', focus: true, title: '이미지 주소 (선택)',
        text: '그림을 넣으려면 **이미지 주소**를 붙여 넣으세요.', sub: '인터넷 그림에서 마우스 오른쪽 버튼 → ‘이미지 주소 복사’. 비워 둬도 돼요.' },
      { target: '#new-product-name', focus: true, title: '상품 이름', text: '**상품 이름**을 적으세요.' },
      { target: '#new-product-price', focus: true, title: '가격', text: '**가격**을 적으세요.' },
      { target: '#new-product-stock', focus: true, title: '재고', text: '**재고** 수를 적으세요. 0이 되면 팔리지 않아요.' },
      { target: '#new-product-category', focus: true, title: '분류 (선택)',
        text: '**분류**를 적거나 고르세요. 같은 분류끼리 매점 화면의 탭으로 묶여요.', sub: '예: 간식, 학용품, 특권' },
      { target: '#new-product-order', focus: true, title: '목록 순서', text: '**목록 순서**를 적으세요. 작은 숫자가 앞에 보여요.' },
      { target: '[aria-label="새 상품 판매중"]', look: true, title: '판매 중', text: '**판매 중**을 끄면 매점에서 숨겨져요.', sub: '잠시 팔지 않을 때 끄면 돼요.' },
      { target: '[aria-label="새 상품 디지털 상품"]', skipUnless: '[aria-label="새 상품 디지털 상품"]', look: true, title: '디지털 상품 (필요할 때만)',
        text: '간식, 학용품 같은 **실물 상품**이라면 **디지털 상품**은 꺼 둔 채로 두세요. 대부분의 상품은 끈 채로 팔아요.',
        sub: '켜면 학생이 산 물건이 실물 대신 학생 **보관함**에 들어가요. 자리 바꾸기권, 숙제 면제 쿠폰, 칭찬 배지처럼 손에 쥘 물건이 없는 상품에만 켜세요.' },
      { target: '#new-product-digital-kind', skipUnless: '#new-product-digital-kind', title: '디지털 상품 유형',
        text: '켰다면 **유형**을 고르세요. **소모품**은 쿠폰처럼 한 번 쓰면 없어지고, **수집품**은 배지, 상장처럼 쓰지 않고 모아 두는 아이템이에요.',
        sub: '학생이 소모품을 쓰면 학생 편집 창의 보관함에서 [사용함]을 눌러 처리해요. 따라 하기: 도움말 3-6' },
      { target: '#new-product-digital-description', skipUnless: '#new-product-digital-description', focus: true, title: '보관함 설명 (선택)',
        text: '학생이 보관함에서 이 아이템을 누르면 보이는 **설명**이에요. 쓰는 방법을 적어 두세요.', sub: '예: 원하는 자리로 일주일 동안 옮길 수 있어요.' },
      { target: '[data-tour="product-create"]', area: ['@footer'], title: '추가하기',
        text: '[새 상품 추가]를 누르세요.', warn: '누르면 매점에 바로 올라가요.' },
    ],
  },
  {
    id: '4-2',
    title: '상품 고치기, 판매 멈추기, 지우기',
    goal: '상품 편집 창에서 가격, 재고를 고치고, 판매를 잠시 멈추거나 상품을 지워요.',
    steps: [
      menu('products', '상품 고치기는'),
      { tab: 'products', reveal: '#admin-store-tab-inventory', target: '[data-testid="product-row"] button[aria-label$=" 편집"]', area: [{ closest: '[data-testid="product-row"]' }],
        title: '상품 고르기', text: '고칠 **상품 이름**을 누르세요. 오른쪽에 편집 창이 열려요.',
        sub: '[다음]을 누르면 맨 위 상품으로 보여 드려요. 목록 위의 검색과 [전체], [판매 중], [판매 중지]로 찾을 수 있어요.',
        next: { wait: PRODUCT_SHEET }, advanceWhen: PRODUCT_SHEET, missing: '먼저 상품을 등록해 주세요. 도움말 4-1에서 따라 할 수 있어요.' },
      { target: '#product-sheet-price', focus: true, title: '가격', text: '**가격**을 고치세요.', sub: '이미 판 거래의 금액은 바뀌지 않아요.' },
      { target: '#product-sheet-stock', focus: true, title: '재고', text: '**재고**를 고치세요. 새로 들여온 만큼 더한 수를 적어요.', sub: '0이 되면 매점에서 살 수 없어요.' },
      { target: `${PRODUCT_SHEET} [aria-label$=" 판매중"]`, look: true, title: '판매 멈추기',
        text: '**판매 중**을 끄면 매점에서 숨겨져요. 다시 켜면 다시 팔아요.', sub: '지우지 않고 잠시 멈출 때 써요. 상품 목록에는 ‘판매 중지’로 보여요.' },
      { target: `${PRODUCT_SHEET} [aria-label$=" 상품 삭제"]`, area: ['@footer'], peek: true, title: '지우기',
        text: '[삭제]는 상품을 지워요. 누르면 한 번 더 물어봐요.', sub: '여러 상품은 목록에서 체크한 뒤 아래 막대의 [삭제]로 한꺼번에 지워요.',
        warn: '지운 상품은 매점에서 바로 사라져요. 지난 거래 기록은 남아요. 잠시 멈출 때는 삭제 대신 **판매 중**을 끄세요.' },
      { target: '[data-tour="product-save"]', area: ['@footer'], title: '저장하기',
        text: '고친 뒤 [저장]을 누르세요. 바꾼 것이 없으면 버튼이 흐려요.', warn: '저장하면 매점에 바로 반영돼요.' },
    ],
  },
  {
    id: '4-3',
    title: '할인 행사 만들기',
    goal: '1+1, 할인가 같은 매점 행사를 기간과 대상 상품을 정해 만들어요.',
    steps: [
      menu('products', '할인 행사는'),
      { tab: 'products', target: '#admin-store-tab-promotions', area: [{ closest: '[role="tablist"]' }], title: '행사 관리 탭',
        text: '[행사 관리] 탭을 누르세요.', next: { click: '#admin-store-tab-promotions', wait: '[aria-label="행사명"]' }, advanceWhen: '[aria-label="행사명"]',
        clickMovesOn: true },
      { reveal: '#admin-store-tab-promotions', target: '[aria-label="행사명"]', area: [{ closest: 'label' }], focus: true, title: '행사명',
        text: '**행사명**을 적으세요.', sub: '예: 과자 1+1, 금요일 학용품 할인' },
      { reveal: '#admin-store-tab-promotions', target: '[aria-label="행사 설명"]', area: [{ closest: 'label' }], focus: true, title: '행사 설명',
        text: '필요하면 **행사 설명**을 적으세요.' },
      { reveal: '#admin-store-tab-promotions', target: '[aria-label="행사 유형"]', area: [{ closest: 'label' }], title: '행사 유형',
        text: '**행사 유형**을 고르세요.',
        sub: '**N+1**은 정한 개수를 사면 몇 개를 더 주고, **행사 가격**은 한 개 값을 새로 정해요. **퍼센트 할인**은 정한 비율만큼, **정액 할인**은 한 개마다 정한 금액만큼 깎아 줘요.' },
      { reveal: '#admin-store-tab-promotions', target: '[data-tour="promo-amounts"] input', area: ['[data-tour="promo-amounts"]'], title: '수량, 금액',
        text: '고른 유형에 맞춰 **수량이나 금액**을 적으세요.', sub: '예: 1+1이면 구매 수량 1, 무료 수량 1' },
      { reveal: '#admin-store-tab-promotions', target: '[aria-label="시작 일시"]', area: ['[data-tour="promo-dates"]'], title: '행사 기간',
        text: '**시작 일시**와 **종료 일시**를 정하세요. 이 기간에만 할인돼요.' },
      { reveal: '#admin-store-tab-promotions', target: '[aria-label="정렬 우선순위"]', area: [{ closest: 'label' }], look: true, title: '우선순위',
        text: '같은 상품에 같은 유형의 행사가 여러 개면 **작은 숫자**부터 적용해요.', sub: '행사가 하나뿐이면 그대로 두면 돼요.' },
      { reveal: '#admin-store-tab-promotions', target: '[aria-label="행사 활성"]', area: [{ closest: 'label' }], look: true, title: '활성',
        text: '**활성**을 끄면 만들어 두기만 하고 적용하지 않아요.' },
      { reveal: '#admin-store-tab-promotions', target: '[aria-label$=" 대상"]', area: [{ closest: 'fieldset' }], title: '대상 상품',
        text: '행사를 적용할 **대상 상품**을 체크하세요.', missing: '먼저 매점에 상품을 등록해 주세요. 도움말 4-1에서 따라 할 수 있어요.' },
      { reveal: '#admin-store-tab-promotions', target: '[aria-label="미리보기 상품"]', area: ['[data-tour="promo-preview"]'], look: true, title: '가격 미리보기',
        text: '**미리보기 상품**과 수량을 고르면 행사를 적용한 최종 합계를 보여 줘요.', sub: '추가하기 전에 계산이 맞는지 확인해요.' },
      { reveal: '#admin-store-tab-promotions', target: '[data-tour="promo-create"]', area: ['@target'], title: '추가하기',
        text: '[행사 추가]를 누르세요. **행사 목록**에 새 행사가 생겨요.', warn: '활성인 행사는 기간 안이면 매점 결제에 바로 적용돼요.' },
    ],
  },
  {
    id: '4-4',
    title: '행사 고치기, 끄기, 지우기',
    goal: '행사 목록에서 행사를 고치고, 잠시 끄거나 지워요.',
    steps: [
      menu('products', '할인 행사는'),
      { tab: 'products', target: '#admin-store-tab-promotions', area: [{ closest: '[role="tablist"]' }], title: '행사 관리 탭',
        text: '[행사 관리] 탭을 누르세요.', next: { click: '#admin-store-tab-promotions', wait: '[aria-label="행사명"]' }, advanceWhen: '[aria-label="행사명"]',
        clickMovesOn: true },
      { reveal: '#admin-store-tab-promotions', target: '[data-testid="promotion-row"]', area: ['@target'], peek: true, title: '행사 목록',
        text: '**행사 목록**에서 진행 중인지와 할인 내용, 대상 상품, 기간을 봐요.', missing: '등록된 행사가 없어요. 도움말 4-3으로 먼저 만들어 주세요.' },
      { reveal: '#admin-store-tab-promotions', target: ['[data-testid="promotion-row"] button[aria-label$=" 비활성화"]', '[data-testid="promotion-row"] button[aria-label$=" 재활성화"]'],
        area: [{ closest: '[data-testid="promotion-row"]' }], look: true, title: '끄기, 다시 켜기',
        text: '[비활성화]를 누르면 행사를 지우지 않고 멈춰요. [재활성화]로 다시 켜요.', warn: '누르는 즉시 매점에 반영돼요.',
        missing: '등록된 행사가 없어요. 도움말 4-3으로 먼저 만들어 주세요.' },
      { reveal: '#admin-store-tab-promotions', target: '[data-testid="promotion-row"] button[aria-label$=" 삭제"]', area: [{ closest: '[data-testid="promotion-row"]' }], peek: true, title: '지우기',
        text: '[삭제]는 행사를 지워요.', warn: '한 번 더 물어본 뒤 지워요. 지운 행사는 되돌릴 수 없어요.', missing: '등록된 행사가 없어요. 도움말 4-3으로 먼저 만들어 주세요.' },
      { reveal: '#admin-store-tab-promotions', target: '[data-testid="promotion-row"] button[aria-label$=" 편집"]', area: [{ closest: '[data-testid="promotion-row"]' }], title: '고치기',
        text: '[편집]을 누르세요.', next: { wait: '[aria-labelledby="promotion-edit-title"]' }, advanceWhen: '[aria-labelledby="promotion-edit-title"]',
        missing: '등록된 행사가 없어요. 도움말 4-3으로 먼저 만들어 주세요.' },
      { target: '[aria-labelledby="promotion-edit-title"] [aria-label="수정 행사명"]', area: [{ closest: 'label' }], title: '바꿀 곳 고치기',
        text: '만들 때와 같은 칸이 열려요. 기간, 할인 내용, 대상 상품 등 바꿀 곳을 고치세요.' },
      { target: '[data-tour="promo-edit-save"]', area: ['@parent'], title: '저장하기',
        text: '[행사 수정 저장]을 누르세요. [편집 취소]는 바꾼 것을 버려요.', warn: '저장하면 매점에 바로 반영돼요.' },
    ],
  },
  {
    id: '5-0',
    title: '과제 단계 이해하기',
    goal: '과제는 학생마다 미부여 → 미완료 → 완료 가능 → 완료 네 단계로 관리해요.',
    ledger: true,
    steps: [
      menu('tasks', '과제 관리는'),
      { tab: 'tasks', target: '#admin-panel-tasks [data-page-header]', area: ['@target'], peek: true, title: '네 단계',
        text: '과제는 학생마다 **미부여 → 미완료 → 완료 가능 → 완료** 단계로 관리해요.',
        sub: '선생님이 단계를 바꾸고, 학생은 ‘완료 가능’일 때 은행에서 직접 완료해 보상을 받아요.' },
      { tab: 'tasks', target: '[data-testid="task-row"] [role="img"][aria-label*=" 단계: "]', area: [{ closest: '[data-testid="task-row"]' }], peek: true, title: '목록에서 보기',
        text: '과제 목록의 막대와 숫자로 **단계별 학생 수**를 봐요.', sub: '미완료, 완료 가능, 완료가 색으로 나뉘고, 미부여는 흐리게 보여요.', missing: NO_TASKS },
      openTask('아무 **과제 이름**이나 눌러 보세요.'),
      openTaskTab('students', '학생 현황', '[data-tour="stage-legend"]'),
      { reveal: taskTab('students'), target: '[data-tour="stage-legend"]', area: ['@target'], peek: true, title: '단계의 뜻',
        text: '**미부여**는 학생에게 안 보이고, **미완료**는 보이지만 아직 완료할 수 없어요. **완료 가능**이면 학생이 은행에서 완료하고 보상을 받아요.',
        sub: '**완료**는 끝낸 과제예요. 선생님이 직접 완료로 바꿀 때는 보상을 줄지 물어봐요.' },
      { reveal: taskTab('students'), target: '[data-tour="stage-counts"]', area: ['@target'], peek: true, title: '흔한 흐름',
        text: '흔히 과제를 **미완료**로 내주고, 해 온 것을 확인한 학생을 **완료 가능**으로 바꿔 줘요.',
        sub: '반복 과제는 정한 때가 되면 학생들이 고른 단계로 저절로 돌아가요(도움말 5-2). 패들렛을 연결하면 글을 올린 학생이 저절로 ‘완료 가능’이 돼요(도움말 5-7).' },
    ],
  },
  {
    id: '5-1',
    title: '새 과제 만들기',
    goal: '과제 이름, 설명, 보상과 기간을 정하고, 과제를 줄 학생을 골라요.',
    ledger: true,
    steps: [
      menu('tasks', '과제 만들기는'),
      { tab: 'tasks', target: '[data-tour="task-new"]', area: ['@header'], title: '새 과제 창 열기',
        text: '[새 과제]를 누르세요. 오른쪽에 과제 창이 열려요.', next: { wait: dialog('새 과제') }, advanceWhen: dialog('새 과제') },
      { target: `${dialog('새 과제')} [role="tablist"]`, area: ['@target'], peek: true, title: '탭 세 개',
        text: '창 위의 [기본 정보], [반복], [대상 학생] 탭을 차례로 채워요.', sub: '바꾼 탭에는 점이 붙어요. 반복은 매일, 매주 다시 하는 과제에만 정하면 돼요.' },
      { target: '[aria-label="새 과제 과제 이름"]', focus: true, title: '과제 이름', text: '**과제 이름**을 적으세요.', sub: '예: 수학 익힘책 42~45쪽' },
      { target: '[aria-label="새 과제 설명"]', focus: true, title: '설명 (선택)', text: '**설명**을 적으세요. 학생이 은행에서 봐요.' },
      { target: '[aria-label="새 과제 보상"]', focus: true, title: '보상', text: '**보상** 금액을 적으세요. 학생이 완료하면 받아요.' },
      { target: '[aria-label="새 과제 학생에게 보이기"]', look: true, title: '학생에게 보이기', text: '**학생에게 보이기**를 끄면 은행에서 숨겨져요.' },
      { target: '[aria-label="새 과제 시작 시각"]', area: [{ closest: 'fieldset' }], title: '기간 (선택)',
        text: '**기간**을 정하세요. 시작을 비우면 바로, 마감을 비우면 마감 없이 열려요.' },
      { target: '[aria-label="새 과제 선행 과제"]', look: true, title: '먼저 끝내야 하는 과제 (선택)',
        text: '고르면 그 과제를 완료한 학생만 이 과제를 완료할 수 있어요.' },
      { target: `${dialog('새 과제')} [data-tour="sheet-tab-students"]`, area: [{ closest: '[role="tablist"]' }], title: '대상 학생 탭',
        text: '[대상 학생] 탭을 누르세요.', next: { click: `${dialog('새 과제')} [data-tour="sheet-tab-students"]`, wait: '[data-tour="task-targets-bar"]' },
        advanceWhen: '[data-tour="task-targets-bar"]', clickMovesOn: true },
      { reveal: `${dialog('새 과제')} [data-tour="sheet-tab-students"]`, target: '[aria-label="모든 학생 고르기"]', area: ['[data-tour="task-targets-bar"]'], title: '학생 고르기',
        text: '과제를 줄 학생을 체크하세요. **모든 학생**을 체크하면 반 전체를 골라요.',
        sub: '고른 뒤 **고른 학생 모두** 옆 버튼으로 처음 단계를 한꺼번에 정해요. 고르지 않은 학생은 미부여라 학생에게 보이지 않아요.' },
      { reveal: `${dialog('새 과제')} [data-tour="sheet-tab-students"]`, target: '[data-tour="task-target-row"] [role="group"]', area: [{ closest: '[data-tour="task-target-row"]' }], look: true, title: '학생마다 처음 단계',
        text: '학생 줄 오른쪽 버튼으로 학생마다 **처음 단계**를 바꿔요.', sub: '**미부여**를 누르면 그 학생은 대상에서 빠져요. 흔히 ‘미완료’로 내고, 확인한 학생을 ‘완료 가능’으로 바꿔요.' },
      { target: '[data-tour="task-create"]', area: ['@footer'], title: '만들기',
        text: '[과제 만들기]를 누르세요.', warn: '누르면 과제가 바로 만들어지고, 고른 학생의 은행 화면에 보여요.' },
    ],
  },
  {
    id: '5-2',
    title: '반복 과제 정하기',
    goal: '매일, 매주, 매월 다시 하는 과제를 정해, 정한 때가 되면 학생 단계가 저절로 돌아가게 해요.',
    ledger: true,
    steps: [
      menu('tasks', '반복 과제 설정은'),
      openTask('반복을 정할 **과제 이름**을 누르세요.'),
      openTaskTab('repeat', '반복', `${TASK_SHEET} [role="group"][aria-label="반복 주기"]`),
      { reveal: taskTab('repeat'), target: `${TASK_SHEET} [role="group"][aria-label="반복 주기"]`, area: ['@parent'], title: '반복 주기',
        text: '**반복 주기**를 고르세요: 반복 없음, 매일, 매주, 매월', sub: '숙제처럼 매번 다시 하는 과제라면 주기를 골라요.' },
      { target: `${TASK_SHEET} fieldset[aria-label="반복 요일"] button`, area: [{ closest: 'fieldset' }], skipUnless: `${TASK_SHEET} fieldset[aria-label="반복 요일"]`, title: '요일',
        text: '매주라면 **요일**을 누르세요. 여러 요일을 고를 수 있어요.' },
      { target: `${TASK_SHEET} [aria-label="반복 날짜"]`, skipUnless: `${TASK_SHEET} [aria-label="반복 날짜"]`, title: '날짜',
        text: '매월이라면 **날짜**를 적으세요.', sub: '29~31일이 없는 달은 그 달 마지막 날에 초기화해요.' },
      { target: `${TASK_SHEET} [aria-label="반복 시간"]`, skipUnless: `${TASK_SHEET} [aria-label="반복 시간"]`, title: '초기화 시각',
        text: '**초기화 시각**을 정하세요. 이 시각마다 학생 단계가 돌아가요.' },
      { target: `${TASK_SHEET} [role="group"][aria-label="초기화하면"]`, area: ['@parent'], skipUnless: `${TASK_SHEET} [role="group"][aria-label="초기화하면"]`, title: '초기화하면',
        text: '초기화할 때 학생을 **어느 단계로** 돌릴지 고르세요.', sub: '흔히 **미완료**로 돌려 다시 하게 해요. 미부여인 학생은 그대로예요.' },
      { target: `${TASK_SHEET} [data-tour="task-repeat-save"]`, area: ['@footer'], title: '저장하기',
        text: '[저장]을 누르세요. 창 안의 파란 글씨로 **다음 초기화** 때를 확인해요.',
        sub: '여러 과제에 같은 반복을 정하려면 과제 목록에서 체크한 뒤 [반복 설정]을 눌러요. 따라 하기: 도움말 5-6', warn: '저장하면 그때부터 정한 시각마다 저절로 초기화돼요.' },
    ],
  },
  {
    id: '5-3',
    title: '학생에게 과제 내주기',
    goal: '과제를 받지 않은(미부여) 학생을 골라 ‘미완료’로 바꾸면 학생 은행 화면에 과제가 생겨요.',
    ledger: true,
    steps: [
      menu('tasks', '과제 내주기는'),
      openTask('내줄 **과제 이름**을 누르세요.'),
      openTaskTab('students', '학생 현황', '[data-tour="stage-pick-bar"]'),
      { reveal: taskTab('students'), target: `${TASK_SHEET} [aria-label="학생 현황 필터"]`, area: ['@target'], title: '미부여만 보기',
        text: '[미부여]를 누르세요. 아직 과제를 받지 않은 학생만 보여요.' },
      { reveal: taskTab('students'), target: '[data-tour="stage-pick-bar"] input[type="checkbox"]', area: ['[data-tour="stage-pick-bar"]'], title: '학생 고르기',
        text: '**모두 선택**을 체크하면 보이는 학생을 모두 골라요. 몇 명만 줄 때는 학생 줄의 체크 상자를 누르세요.',
        next: { wait: '[role="group"][aria-label="선택한 학생 단계 바꾸기"]' }, advanceWhen: '[role="group"][aria-label="선택한 학생 단계 바꾸기"]' },
      { target: '[role="group"][aria-label="선택한 학생 단계 바꾸기"]', area: ['[data-tour="stage-pick-bar"]'], title: '미완료로 바꾸기',
        text: '‘선택한 학생을’ 옆의 [미완료]를 누르세요.', sub: '한 명씩은 학생 줄 오른쪽 단계 버튼으로 바꿔요. 숙제를 이미 확인했다면 바로 [완료 가능]으로 내도 돼요.',
        missing: '먼저 학생을 골라 주세요. [이전]으로 돌아가 체크 상자를 누르세요.' },
      { target: '[data-tour="task-stages-save"]', area: ['@footer'], title: '저장하기',
        text: '[N명 저장]을 누르세요.', sub: '새 과제를 만들 때 [대상 학생] 탭에서 정하거나(도움말 5-1), 학생 QR을 찍어 내줄 수도 있어요(도움말 5-5).',
        warn: '저장하면 고른 학생의 은행 화면에 과제가 바로 보여요.' },
    ],
  },
  {
    id: '5-4',
    title: '학생 단계 바꾸기, 현황 보기',
    goal: '과제의 ‘학생 현황’ 탭에서 학생마다 단계를 바꾸고 저장해요.',
    ledger: true,
    steps: [
      menu('tasks', '학생 단계 바꾸기는'),
      openTask('단계를 바꿀 **과제 이름**을 누르세요.'),
      openTaskTab('students', '학생 현황', '[data-tour="stage-counts"]'),
      { reveal: taskTab('students'), target: '[data-tour="stage-counts"]', area: ['@target'], peek: true, title: '단계별 학생 수', text: '맨 위 숫자로 **단계별 학생 수**를 봐요.',
        sub: '미부여 → 미완료 → 완료 가능 → 완료. 학생은 ‘완료 가능’일 때만 은행에서 보상을 받아요.' },
      { reveal: taskTab('students'), target: '[aria-label="학생 현황 필터"]', area: ['@target'], look: true, title: '걸러 보기', text: '[전체], [미부여], [미완료], [완료 가능], [완료]로 학생을 걸러 봐요.' },
      { reveal: taskTab('students'), target: '[data-tour="stage-row"] [role="group"]', area: [{ closest: '[data-tour="stage-row"]' }], title: '단계 바꾸기',
        text: '학생 줄 오른쪽에서 **바꿀 단계**를 누르세요.', sub: '바꾼 학생은 파랗게 표시되고 ‘변경’이 붙어요. 여러 명을 체크한 뒤 한꺼번에 바꿀 수도 있어요.' },
      { target: '[data-tour="task-stages-save"]', area: ['@footer'], title: '저장하기',
        text: '[N명 저장]을 누르세요. [되돌리기]는 저장 전으로 돌려요.', sub: '숙제를 확인한 학생은 ‘완료 가능’으로 바꿔 주면 학생이 직접 완료하고 보상을 받아요.',
        warn: '저장하면 학생 화면에 바로 반영돼요. ‘완료’로 바꿀 때는 보상을 줄지 물어봐요.' },
    ],
  },
  {
    id: '5-5',
    title: 'QR로 과제 단계 바꾸기',
    goal: '과제와 단계를 고른 뒤 학생 QR을 찍으면, 찍은 학생의 단계가 바로 바뀌어요.',
    ledger: true,
    steps: [
      menu('tasks', 'QR로 단계 바꾸기는'),
      { tab: 'tasks', target: '[data-tour="task-qr"]', area: ['@header'], title: 'QR 창 열기',
        text: '[QR로 단계 바꾸기]를 누르세요.', sub: '홈의 **QR로 과제 부여** 카드도 같은 창을 열어요.',
        next: { wait: dialog('QR로 단계 바꾸기') }, advanceWhen: dialog('QR로 단계 바꾸기') },
      { target: `${dialog('QR로 단계 바꾸기')} button[aria-label$=" 과제 선택"]`, area: ['@parent'], title: '과제 고르기',
        text: '단계를 바꿀 **과제**를 누르세요.', next: { wait: '[role="group"][aria-label="바꿀 단계"]' }, advanceWhen: '[role="group"][aria-label="바꿀 단계"]',
        missing: NO_TASKS },
      { target: `${dialog('QR로 단계 바꾸기')} [role="group"][aria-label="바꿀 단계"]`, area: ['@parent'], title: '바꿀 단계',
        text: 'QR을 찍은 학생을 **어느 단계로** 바꿀지 고르세요.', sub: '과제를 내줄 때는 ‘미완료’, 해 온 것을 확인했을 때는 ‘완료 가능’을 골라요.' },
      { target: '[aria-label="보상도 주기"]', skipUnless: '[aria-label="보상도 주기"]', look: true, title: '보상도 주기',
        text: '‘완료’로 바꿀 때 **보상도 주기**를 켜면 찍은 학생에게 과제 보상을 바로 줘요.', sub: '끄면 보상 없이 완료로만 바꿔요.' },
      { target: '[data-tour="task-qr-start"]', area: ['@footer'], title: 'QR 찍기',
        text: '[QR 찍기 시작]을 누르고 학생 QR을 차례로 찍으세요.', sub: '결과는 창 아래에 한 줄씩 보여요. 이미 그 단계인 학생은 그대로 두고 알려 줘요.',
        warn: '찍는 즉시 단계가 바뀌어요.' },
    ],
  },
  {
    id: '5-6',
    title: '여러 과제를 골라 한꺼번에 처리하기',
    goal: '과제를 체크해 반복, 완료 단계, 패들렛, 지금 초기화, 삭제를 한꺼번에 해요.',
    ledger: true,
    steps: [
      menu('tasks', '여러 과제 처리는'),
      pickRows('tasks', '[data-testid="task-row"]', '과제 줄 왼쪽 **체크 상자**로 과제를 고르세요.', NO_TASKS),
      { target: TOOLBAR, area: ['@target'], peek: true, title: '작업 막대',
        text: '아래 **작업 막대**에서 고른 과제 모두에 한 번에 할 일을 골라요.', sub: '[반복 설정]은 같은 반복을, [패들렛]은 같은 게시판을 정해요. 따라 하기: 도움말 5-2, 5-9',
        missing: '과제를 하나 이상 고르면 작업 막대가 나와요.' },
      { target: '[aria-label="선택 과제 지금 초기화"]', area: [TOOLBAR], peek: true, title: '지금 초기화',
        text: '[지금 초기화]는 반복 시각을 기다리지 않고 지금 바로 학생 단계를 돌려요.', sub: '누르면 돌릴 단계를 고르는 창이 먼저 열려요.' },
      { target: '[aria-label="선택 과제 삭제"]', area: [TOOLBAR], peek: true, title: '삭제',
        text: '[삭제]는 고른 과제를 지워요.', warn: '한 번 더 물어본 뒤 지워요. 지운 과제는 되돌릴 수 없어요.' },
      { target: '[aria-label="선택 과제 완료 단계"]', area: [TOOLBAR], title: '완료 단계',
        text: '[완료 단계]를 누르세요. 고른 과제 모두에서 학생 단계를 한 번에 바꿔요.',
        next: { wait: dialog('선택 과제 완료 단계') }, advanceWhen: dialog('선택 과제 완료 단계'), missing: '과제를 하나 이상 고르면 작업 막대가 나와요.' },
      { target: `${dialog('선택 과제 완료 단계')} [role="group"][aria-label="바꿀 단계"]`, area: ['@parent'], title: '바꿀 단계',
        text: '고른 학생을 **어느 단계로** 바꿀지 고르세요.', sub: '여러 과제를 한꺼번에 내줄 때는 ‘미완료’를 골라요.' },
      { target: '[data-tour="bulk-stage-bar"] input[type="checkbox"]', area: ['[data-tour="bulk-stage-bar"]'], title: '학생 고르기',
        text: '**모든 학생**을 체크하거나, 아래에서 학생을 하나씩 고르세요.' },
      { target: '[data-tour="bulk-stages-save"]', area: ['@footer'], title: '저장하기',
        text: '바뀌는 학생 수를 확인하고 [저장]을 누르세요.', warn: '저장하면 고른 과제 모두에 바로 반영돼요. ‘완료’로 바꿀 때는 보상을 줄지 물어봐요.' },
    ],
  },
  {
    id: '5-7',
    title: '과제를 패들렛 게시판과 연결하기',
    goal: '패들렛 게시판을 연결하면, 학생이 자기 이름으로 글을 올렸을 때 과제가 저절로 ‘완료 가능’이 돼요.',
    ledger: true,
    steps: [
      menu('tasks', '패들렛 연결은'),
      openTask('패들렛에 연결할 **과제 이름**을 누르세요.'),
      openTaskTab('padlet', '연결', '[data-tour="link-provider"], [data-testid="padlet-link-form"], [data-testid="padlet-linked"]'),
      { reveal: taskTab('padlet'), target: '[data-tour="link-provider"]', area: ['@target'], skipUnless: '[data-tour="link-provider"]', title: '패들렛 고르기',
        text: '[패들렛]을 누르세요.', sub: '[딴쌤 보드]를 고르면 딴쌤 보드와 연결해요(도움말 5-10).',
        advanceWhen: '[data-testid="padlet-link-form"], [data-testid="padlet-linked"]' },
      { target: '[data-tour="padlet-change"]', area: ['[data-tour="padlet-linked-board"]'], skipUnless: '[data-testid="padlet-linked"]', look: true, title: '이미 연결된 과제',
        text: '이 과제는 이미 게시판에 연결돼 있어요. 다른 게시판으로 바꾸려면 [다른 게시판으로 바꾸기]를 누르세요.',
        sub: '그대로 두려면 도움말을 끝내세요. 글이 어떻게 반영됐는지는 도움말 5-8에서 볼 수 있어요.',
        next: { wait: '[data-testid="padlet-link-form"]' }, advanceWhen: '[data-testid="padlet-link-form"]' },
      { reveal: taskTab('padlet'), target: '[data-tour="padlet-key"]', area: ['@target'], look: true, title: 'Padlet API 키',
        text: '게시판을 읽으려면 **Padlet API 키**가 있어야 해요. 한 번 넣으면 학급의 모든 과제가 함께 써요.',
        sub: '키가 없다면 ‘Padlet에서 API 키 보기’를 눌러 유료(Gold, Platinum) 계정의 키를 복사해 붙여 넣고 [키 저장]을 누르세요. 이미 넣었다면 끝자리만 보여요.' },
      { target: '[data-tour="padlet-address"]', focus: true, title: '게시판 주소',
        text: '연결할 **게시판 주소**를 붙여 넣고 [불러오기]를 누르세요.', sub: '게시판을 열고 주소창의 주소를 그대로 복사해요.',
        advanceWhen: '[data-testid="padlet-board-preview"]', missing: 'API 키를 저장하면 게시판 주소 칸이 나와요.' },
      { target: ['[role="radiogroup"][aria-label="글을 셀 섹션"]', '[data-testid="padlet-board-preview"]'], area: ['[data-testid="padlet-board-preview"]'], title: '게시판 확인',
        text: '불러온 게시판이 맞는지 확인하고, 글을 셀 **칸(섹션)**을 고르세요.', sub: '**게시판 전체**를 고르면 모든 칸의 글을 세요.',
        missing: '주소를 넣고 [불러오기]를 누르면 게시판 정보가 나와요.' },
      PADLET_RULES,
      { target: '[data-tour="padlet-connect"]', area: ['@parent'], title: '연결하기',
        text: '[이 게시판에 연결]을 누르세요.', warn: '연결하면 바로 게시판을 읽어요. 이미 올라온 글로 ‘미완료’ 학생이 곧바로 ‘완료 가능’이 될 수 있어요.' },
    ],
  },
  {
    id: '5-8',
    title: '패들렛 글이 어떻게 반영됐는지 보기',
    goal: '연결된 과제의 패들렛 탭에서 마지막 확인 시각과 글마다 반영된 결과를 봐요.',
    ledger: true,
    steps: [
      menu('tasks', '패들렛 글이 반영된 결과는', '봐요'),
      { tab: 'tasks', target: '[data-testid="task-row"][data-padlet] button[aria-label$=" 과제 편집"]', area: [{ closest: '[data-testid="task-row"]' }], title: '연결된 과제 고르기',
        text: '패들렛에 연결된 **과제 이름**을 누르세요.', sub: '연결된 과제는 이름 아래에 ‘패들렛: 게시판 이름’이 보여요.',
        next: { wait: TASK_SHEET }, advanceWhen: TASK_SHEET, missing: '패들렛에 연결된 과제가 없어요. 도움말 5-7로 먼저 연결해 주세요.' },
      openTaskTab('padlet', '연결', '[data-testid="padlet-linked"]'),
      { reveal: taskTab('padlet'), target: '[data-tour="padlet-linked-board"]', area: ['@target'], peek: true, title: '연결 상태',
        text: '연결된 **게시판**과 세는 칸, **마지막 확인** 시각을 봐요.', sub: '확인에 실패하면 노란 글씨로 이유가 나와요.',
        missing: '이 과제는 패들렛에 연결돼 있지 않아요. [이전]으로 돌아가 연결된 과제를 고르세요.' },
      { reveal: taskTab('padlet'), target: '[data-tour="padlet-sync"]', area: ['@parent'], look: true, title: '지금 확인',
        text: '[지금 확인]을 누르면 게시판을 바로 다시 읽어요.', sub: '과제 화면이나 학생 화면을 열 때도 저절로 확인해요.',
        warn: '새 글을 올린 ‘미완료’ 학생은 확인하는 즉시 ‘완료 가능’이 돼요.' },
      { reveal: taskTab('padlet'), target: 'section[aria-labelledby="padlet-posts-heading"]', area: ['@target'], peek: true, title: '최근 글',
        text: '**최근 글**마다 이 과제에 어떻게 반영됐는지 표시돼요.',
        sub: '‘완료 가능으로 바꿈’은 반영된 글이에요. ‘미완료가 되기 전에 쓴 글’, ‘학생 이름을 못 찾음’ 같은 글은 세지 않았어요. 이름을 못 찾았다면 학생에게 글 제목에 이름을 쓰게 해 주세요.' },
      { target: '[aria-label$=" 완료 가능으로 바꾸기"]', area: [{ closest: '[data-testid="padlet-post"]' }], skipUnless: '[aria-label$=" 완료 가능으로 바꾸기"]', look: true, title: '과제 없는 학생의 글',
        text: '과제를 받지 않은(미부여) 학생이 글을 올렸다면 [완료 가능으로]를 눌러 바로 과제를 주고 완료 가능으로 바꿀 수 있어요.',
        warn: '누르는 즉시 그 학생의 단계가 바뀌어요.' },
    ],
  },
  {
    id: '5-9',
    title: '여러 과제를 한 게시판에 연결하기',
    goal: '체크한 과제 모두를 같은 패들렛 게시판에 연결해요. 연계된 과제는 글 하나에 앞 과제부터 하나씩 완료 가능이 돼요.',
    ledger: true,
    steps: [
      menu('tasks', '패들렛 연결은'),
      pickRows('tasks', '[data-testid="task-row"]', '한 게시판에 연결할 과제를 모두 **체크**하세요.', NO_TASKS),
      { target: '[aria-label="선택 과제 연결"]', area: [TOOLBAR], title: '연결',
        text: '아래 작업 막대의 [연결]을 누르세요.', next: { wait: dialog('선택 과제 연결') }, advanceWhen: dialog('선택 과제 연결'),
        missing: '과제를 하나 이상 고르면 작업 막대가 나와요.' },
      { target: `${dialog('선택 과제 연결')} [data-tour="link-provider"]`, area: ['@target'], skipUnless: `${dialog('선택 과제 연결')} [data-tour="link-provider"]`,
        title: '패들렛 고르기', text: '[패들렛]을 누르세요.', advanceWhen: `${dialog('선택 과제 연결')} [data-tour="padlet-key"]` },
      { target: `${dialog('선택 과제 연결')} [data-tour="padlet-key"]`, area: ['@target'], look: true, title: 'Padlet API 키',
        text: '**Padlet API 키**를 확인하세요. 없다면 여기서 넣어요.', sub: '유료(Gold, Platinum) 계정의 키가 필요해요. 한 번 넣으면 학급의 모든 과제가 함께 써요.' },
      { target: `${dialog('선택 과제 연결')} [data-tour="padlet-address"]`, focus: true, title: '게시판 주소',
        text: '**게시판 주소**를 붙여 넣고 [불러오기]를 누르세요.', advanceWhen: `${dialog('선택 과제 연결')} [data-testid="padlet-board-preview"]`,
        missing: 'API 키를 저장하면 게시판 주소 칸이 나와요.' },
      { target: [`${dialog('선택 과제 연결')} [role="radiogroup"][aria-label="글을 셀 섹션"]`, `${dialog('선택 과제 연결')} [data-testid="padlet-board-preview"]`],
        area: [`${dialog('선택 과제 연결')} [data-testid="padlet-board-preview"]`], title: '게시판 확인',
        text: '게시판이 맞는지 확인하고 글을 셀 **칸(섹션)**을 고르세요.', missing: '주소를 넣고 [불러오기]를 누르면 게시판 정보가 나와요.' },
      { target: `${dialog('선택 과제 연결')} [data-tour="padlet-sharing"]`, area: ['@target'], skipUnless: `${dialog('선택 과제 연결')} [data-tour="padlet-sharing"]`,
        peek: true, title: '글 하나가 어떻게 세지나요',
        text: '**연계된 과제**(먼저 끝내야 하는 과제로 이어진 과제)는 글을 하나 올릴 때마다 앞 과제부터 하나씩 완료 가능이 돼요.',
        sub: '연계가 없는 과제끼리는 글 하나로 함께 완료 가능이 돼요. 차례대로 세게 하려면 과제마다 **먼저 끝내야 하는 과제**를 정하세요(도움말 5-1).' },
      { target: `${dialog('선택 과제 연결')} [data-tour="padlet-bulk-connect"]`, area: ['@footer'], title: '연결하기',
        text: '[N개 연결]을 누르세요.', sub: '이미 다른 게시판에 연결된 과제는 새 게시판으로 바뀌어요. [연결 끊기]는 고른 과제의 연결을 풀어요.',
        warn: '연결하면 바로 게시판을 읽어요. 이미 올라온 글로 학생이 곧바로 ‘완료 가능’이 될 수 있어요.' },
    ],
  },
  {
    id: '5-10',
    title: '과제를 딴쌤 보드와 연결하기',
    goal: '딴쌤 보드를 연결하면, 학생이 보드에 글을 올리거나 제출했을 때 과제가 저절로 ‘완료 가능’이 돼요.',
    ledger: true,
    steps: [
      menu('tasks', '딴쌤 보드 연결은'),
      openTask('딴쌤 보드에 연결할 **과제 이름**을 누르세요.'),
      openTaskTab('padlet', '연결', '[data-tour="link-provider"], [data-testid="padlet-link-form"], [data-testid="padlet-linked"]'),
      { reveal: taskTab('padlet'), target: '[data-tour="link-provider"]', area: ['@target'], title: '딴쌤 보드 고르기',
        text: '[딴쌤 보드]를 누르세요.', advanceWhen: '[data-testid="board-link-form"], [data-testid="board-linked"]',
        missing: '딴쌤 보드 연결은 딴쌤 계정으로 로그인한 학급에서 보여요.' },
      { target: '[data-tour="board-change"]', area: ['[data-tour="board-linked-board"]'], skipUnless: '[data-testid="board-linked"]', look: true, title: '이미 연결된 과제',
        text: '이 과제는 이미 보드에 연결돼 있어요. 다른 보드로 바꾸려면 [다른 보드로 바꾸기]를 누르세요.',
        next: { wait: '[data-testid="board-link-form"]' }, advanceWhen: '[data-testid="board-link-form"]' },
      { reveal: taskTab('padlet'), target: '[data-tour="board-picker"]', area: ['@target'], title: '보드 고르기',
        text: '연결할 **보드**를 고르세요.', sub: '그룹 보드는 글을 셀 그룹을 고를 수 있어요. 흐린 보드는 다른 학급 명단과 연결된 보드예요.',
        missing: '딴쌤 보드에서 보드를 먼저 만든 뒤 [새로고침]을 누르세요.' },
      { target: '[data-tour="board-rules"]', area: ['@target'], peek: true, title: '무엇을 세나요',
        text: '과제를 받은 뒤 학생이 보드에 올린 **공개된 글**만 세요. 퀴즈와 설문 보드는 **제출**을 세요.',
        sub: '승인 대기 글은 승인되면 그때 세요. 학생은 은행 과제의 [보드 열기]로 따로 입장하지 않고 들어가요.' },
      { target: '[data-tour="board-connect"]', area: ['@parent'], title: '연결하기',
        text: '[이 보드에 연결]을 누르세요.', sub: '명단이 아직 연결되지 않은 보드는 이 학급 명단과 함께 연결돼요.',
        warn: '연결하면 바로 보드를 확인해요. 이미 있는 글로 ‘미완료’ 학생이 곧바로 ‘완료 가능’이 될 수 있어요.' },
    ],
  },
  {
    id: '6-1',
    title: 'QR로 화폐 지급, 회수하기',
    goal: '금액을 정하고 학생 QR을 찍으면 바로 주거나 거둬요. 모두 거래 내역에 남아요.',
    steps: [
      menu('currency', '화폐 지급과 회수는'),
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
    id: '6-2',
    title: '거래 내역 확인하고 취소하기',
    goal: '매점 결제, 과제 보상, 지급과 회수 기록을 찾아보고, 잘못된 거래를 취소해요.',
    steps: [
      menu('transactions', '거래 기록은', '봐요'),
      { tab: 'transactions', target: '[data-tour="tx-stats"]', area: ['@target'], peek: true, title: '합계',
        text: '**수입, 지출, 거래 수**를 봐요. 취소된 거래는 빼고 세요.' },
      { tab: 'transactions', target: '[aria-label="거래 검색"]', area: ['[data-tour="tx-tools"]'], look: true, title: '찾기',
        text: '학생 이름이나 상품으로 **검색**하고, [전체], [수입], [지출]로 걸러 봐요.' },
      { tab: 'transactions', target: '[aria-label="거래 시작일"]', area: ['[data-tour="tx-range"]'], skipUnless: '[data-tour="tx-range"]', look: true, title: '기간, 학생',
        text: '**시작일, 종료일**과 **학생 번호**로 기록을 좁혀요.' },
      { tab: 'transactions', target: 'article[data-testid^="transaction-row-"]', area: ['@target'], peek: true, title: '거래 한 줄',
        text: '거래마다 **학생, 종류, 시각, 금액**과 거래 전후의 **잔액**이 보여요.',
        missing: '아직 거래가 없어요. 학생이 매점에서 사거나 과제 보상을 받으면 여기에 기록돼요.' },
      { tab: 'transactions', target: 'button[aria-label$=" 거래 취소"]', area: [{ closest: 'article' }], look: true, title: '거래 취소',
        text: '잘못된 거래는 [거래 취소]를 누르세요. 확인 창이 먼저 열려요.', sub: '취소하면 그 거래를 되돌리는 반대 거래가 기록돼요. 매점 결제는 돈을 돌려주고, 과제 보상은 거둬들여요.',
        advanceWhen: dialog('거래 취소 확인'), missing: '취소할 수 있는 거래가 없어요.' },
      { target: '[data-tour="tx-cancel-confirm"]', area: [{ closest: '[role="dialog"]' }], skipUnless: dialog('거래 취소 확인'), title: '취소 확정',
        text: '무엇이 되돌아가는지 읽고 [거래 취소 확정]을 누르세요. 그만두려면 [돌아가기].',
        warn: '확정하면 되돌릴 수 없어요. 회수할 금액이 잔액보다 크면 잔액이 음수가 될 수 있어요.' },
    ],
  },
  {
    id: '7-1',
    title: '펫 키우기 켜고 성장 정하기',
    goal: '펫 키우기를 켜고, 다 자라는 데 필요한 성장 점수와 먹이, 과제마다 오르는 점수를 정해요.',
    steps: [
      menu('pets', '펫 키우기 설정은'),
      { tab: 'pets', target: '[data-tour="pet-enable"] [role="switch"]', title: '켜기',
        text: '**학생 화면에 펫 키우기 보이기**를 켜세요. 학생이 은행 화면에서 알을 골라 키워요.', sub: '끄면 학생은 펫을 볼 수 없고 자라지도 않아요. 키운 기록은 남아요.' },
      petTab('growth', '성장', '#pet-goal'),
      { tab: 'pets', reveal: '#pet-tab-growth', target: '#pet-goal', focus: true, title: '다 자람 목표',
        text: '**다 자람 목표** 점수를 적으세요. 이만큼 자라면 다 자란 펫이 돼요.', sub: '알 → 아기 → 어린 → 다 자란 순서로 자라요. 학생 화면에는 다음 단계까지의 게이지만 보여요.' },
      { tab: 'pets', reveal: '#pet-tab-growth', target: '#pet-care', title: '먹이 성장',
        text: '먹이를 줄 때마다 오르는 **점수**를 고르세요.', sub: '알일 때는 하루 한 번 ‘알 품어 주기’가 이 점수를 받아요.' },
      { tab: 'pets', reveal: '#pet-tab-growth', target: '#pet-task', title: '과제 완료 성장',
        text: '보상이 있는 과제를 완료할 때마다 오르는 **점수**를 고르세요.' },
      { tab: 'pets', reveal: '#pet-tab-growth', target: '#pet-tasks-week', area: ['section[aria-labelledby="pet-estimate"]'], look: true, title: '예상 기간',
        text: '학생이 일주일에 과제를 몇 개쯤 하는지 적으면 **다 자라기까지 걸리는 기간**을 계산해 줘요.', sub: '참고용이에요. 너무 길거나 짧으면 목표 점수를 조절하세요.' },
      PET_SAVE,
    ],
  },
  {
    id: '7-2',
    title: '먹이와 이용 시간 정하기',
    goal: '먹이 가격과 하루 횟수, 펫과 놀 수 있는 시간을 정해요.',
    steps: [
      menu('pets', '펫 키우기 설정은'),
      petTab('food', '먹이', '#pet-price'),
      { tab: 'pets', reveal: '#pet-tab-food', target: '#pet-price', focus: true, title: '먹이 주기 가격',
        text: '먹이 한 번의 **가격**을 적으세요. 0이면 무료예요.', sub: '알 품어 주기는 항상 무료예요.' },
      { tab: 'pets', reveal: '#pet-tab-food', target: '#pet-limit', title: '하루 횟수',
        text: '학생이 하루에 먹이를 줄 수 있는 **횟수**를 고르세요.', sub: '과제를 완료해서 받는 먹이는 횟수와 상관없어요. 하루에 한 번만 자라게 하려면 1번으로 정해요.' },
      petTab('hours', '이용 시간', '[data-tour="pet-hours"]'),
      { tab: 'pets', reveal: '#pet-tab-hours', target: '[data-tour="pet-hours"] [role="switch"]', look: true, title: '이용 시간',
        text: '**이용 시간**을 켜면 정한 시간에만 펫과 놀 수 있어요. 그 밖에는 펫이 잠들어요.', sub: '꺼 두면 언제든 놀 수 있어요.' },
      { tab: 'pets', reveal: '#pet-tab-hours', target: ['[aria-label="이용 시간 1 시작"]', '[data-tour="pet-hours-add"]'],
        area: ['[data-tour="pet-hours-list"]', '[data-tour="pet-hours-add"]'], title: '시간대',
        text: '**시작 시각**과 **끝 시각**을 넣으세요. [시간대 더하기]로 쉬는 시간마다 여러 개 넣을 수 있어요.', sub: '켜 두고 시간대를 하나도 넣지 않으면 아무 때도 놀 수 없어요.' },
      PET_SAVE,
    ],
  },
  {
    id: '7-3',
    title: '졸업 보상과 꾸미기 상점 정하기',
    goal: '다 자란 펫이 졸업할 때 줄 보상과, 펫 화면의 꾸미기 상점에서 팔 물건을 정해요.',
    steps: [
      menu('pets', '펫 키우기 설정은'),
      petTab('grad', '졸업', '#pet-reward'),
      { tab: 'pets', reveal: '#pet-tab-grad', target: '#pet-reward', focus: true, title: '졸업 보상',
        text: '펫이 졸업할 때 학생에게 줄 **화폐**를 적으세요.', sub: '다 자라면 학생이 원할 때 ‘졸업하기’를 눌러요. 졸업한 펫은 도감에 남고 학생은 새 알을 골라요.' },
      { tab: 'pets', reveal: '#pet-tab-grad', target: '#pet-reward-product', title: '졸업 보상 아이템 (선택)',
        text: '함께 줄 **아이템**을 매점 상품에서 고르세요.', sub: '디지털 상품은 그대로, 다른 상품은 교환권으로 학생 보관함에 들어가요.' },
      petTab('shop', '꾸미기/상점', '[data-tour="pet-shop"]'),
      { tab: 'pets', reveal: '#pet-tab-shop', target: '[data-tour="pet-shop"] [role="switch"]', look: true, title: '상점 열기',
        text: '**상점 열기**를 켜면 학생이 펫 화면에서 꾸미기 물건을 살 수 있어요.', sub: '꾸미기는 성장에 영향이 없어요. 매점 상품 목록에는 나오지 않아요.' },
      { tab: 'pets', reveal: '#pet-tab-shop', target: '#pet-panel-shop [aria-label="물건 종류"]', area: ['@target'], look: true, title: '물건 종류',
        text: '**물건 종류**를 골라 걸러 봐요.' },
      { tab: 'pets', reveal: '#pet-tab-shop', target: '#pet-panel-shop input[aria-label$=" 가격"]', area: [{ closest: 'li' }], title: '값 정하기',
        text: '팔 물건마다 **가격**을 넣으세요. 값을 넣어야 상점에 나오고, 0을 넣으면 무료예요.', sub: '‘팔기’를 끄면 잠깐 팔지 않아요. 기본 물건은 모든 학생이 처음부터 가져요.' },
      PET_SAVE,
    ],
  },
  {
    id: '7-4',
    title: '학생 펫 살펴보고 성장 조정하기',
    goal: '펫 목록에서 학생들의 펫을 살펴보고, 이름을 고치거나 성장을 더하고 빼요.',
    steps: [
      menu('pets', '학생 펫 관리는'),
      { tab: 'pets', reveal: '#pet-tab-list', target: '[data-tour="pet-stats"]', area: ['@target', '[role="tablist"][aria-label="펫 키우기 설정"]'], peek: true, title: '펫 목록',
        text: '[펫 목록] 탭에서 **키우는 학생, 오늘 돌본 학생, 졸업 기다리는 펫, 지금까지 졸업**을 봐요.' },
      { tab: 'pets', reveal: '#pet-tab-list', target: '#pet-sort', area: ['@parent'], look: true, title: '정렬',
        text: '**정렬**을 바꿔 오늘 아직 돌보지 않은 학생을 먼저 볼 수 있어요.' },
      { tab: 'pets', reveal: '#pet-tab-list', target: 'input[aria-label$="의 펫 이름"]', area: [{ closest: 'li, tr' }], look: true, title: '펫 이름 고치기',
        text: '알맞지 않은 **펫 이름**은 고친 뒤 [고치기]를 누르세요.', sub: '학생도 펫 화면에서 펫 이름을 눌러 직접 바꿀 수 있어요.', missing: '아직 알을 고른 학생이 없어요. 학생이 은행 화면에서 알을 고르면 여기에 보여요.' },
      { tab: 'pets', reveal: '#pet-tab-list', target: 'button[aria-label$="의 펫 성장 조정"]', area: [{ closest: 'li, tr' }], title: '성장 조정',
        text: '[조정]을 누르세요. 이 펫의 성장을 더하거나 뺄 수 있어요.', next: { wait: dialog('펫 성장 조정') }, advanceWhen: dialog('펫 성장 조정'),
        missing: '아직 알을 고른 학생이 없어요. 학생이 은행 화면에서 알을 고르면 여기에 보여요.' },
      { target: '#pet-adjust-amount', area: ['@field', `${dialog('펫 성장 조정')} [role="group"][aria-label="자주 쓰는 값"]`], focus: true, title: '바꿀 성장',
        text: '더하거나 뺄 **점수**를 적거나 [1점] [5점] [10점]을 누르세요.', sub: '아래에 더하거나 뺐을 때의 점수와 단계가 미리 보여요.' },
      { target: '[data-tour="pet-adjust-add"]', area: ['@footer'], title: '더하기, 빼기',
        text: '[더하기] 또는 [빼기]를 누르세요.', warn: '누르면 학생 화면에 바로 반영돼요. 부화한 펫은 알로 돌아가지 않아요.' },
    ],
  },
  {
    id: '8-1',
    title: '나무 키우기 켜고 목표 정하기',
    goal: '반 전체가 함께 키우는 학급 나무의 이름과 목표 양분, 양분 주는 방법을 정해요.',
    steps: [
      menu('tree', '나무 키우기 설정은'),
      { tab: 'tree', target: '[data-tour="tree-enable"] [role="switch"]', skipUnless: '[data-tour="tree-enable"]', title: '켜기',
        text: '**학생 화면에 학급 나무 보이기**를 켜세요. 켜야 학생들이 양분을 줄 수 있어요.', sub: '끄면 나무가 숨겨지고 양분도 쌓이지 않아요. 쌓인 양분은 남아요.' },
      { tab: 'tree', target: '#tree-name', focus: true, title: '나무 이름', text: '**나무 이름**을 적으세요. 학생의 나무 화면에 이 이름으로 보여요.' },
      { tab: 'tree', target: '#tree-goal', focus: true, title: '목표 양분',
        text: '**목표 양분**을 적으세요. 이만큼 쌓이면 열매가 다 익어요.', sub: '바꾸면 지금 자라는 나무에도 바로 적용돼요.' },
      { tab: 'tree', target: '#tree-price', focus: true, title: '양분 주기 가격', text: '양분 한 번의 **가격**을 적으세요. 0이면 무료예요.' },
      { tab: 'tree', target: '#tree-limit', title: '하루 횟수',
        text: '학생이 하루에 양분을 줄 수 있는 **횟수**를 고르세요.', sub: '과제를 완료해서 받는 양분은 횟수와 상관없어요.' },
      { tab: 'tree', target: '#tree-task', title: '과제 완료 양분', text: '보상이 있는 과제를 완료할 때마다 쌓이는 **양분**을 고르세요.' },
      TREE_SAVE,
    ],
  },
  {
    id: '8-2',
    title: '수확 보상과 예상 기간 정하기',
    goal: '열매를 수확할 때 반 전체에게 줄 보상을 정하고, 다 익기까지 걸리는 기간을 가늠해요.',
    steps: [
      menu('tree', '나무 키우기 설정은'),
      { tab: 'tree', target: '#tree-reward', focus: true, title: '수확 보상',
        text: '열매를 수확할 때 학생 한 명마다 줄 **화폐**를 적으세요.', sub: '보상은 수확할 때의 설정으로 줘요.' },
      { tab: 'tree', target: '#tree-reward-product', title: '수확 보상 아이템 (선택)',
        text: '함께 줄 **아이템**을 매점 상품에서 고르세요.', sub: '디지털 상품은 그대로, 다른 상품은 교환권으로 학생 보관함에 들어가요.' },
      { tab: 'tree', target: '#tree-tasks-week', area: ['section[aria-labelledby="tree-estimate"]'], look: true, title: '예상 기간',
        text: '학생이 일주일에 과제를 몇 개쯤 하는지 적으면 **열매가 익기까지 걸리는 기간**을 계산해 줘요.', sub: '참고용이에요. 너무 길거나 짧으면 목표 양분을 조절하세요(도움말 8-1).' },
      TREE_SAVE,
      { tab: 'tree', target: '[data-tour="tree-harvest"]', area: ['@target'], skipUnless: '[data-tour="tree-harvest"]', look: true, title: '수확하기',
        text: '열매가 다 익었어요. [수확하기]를 누르면 학생 모두에게 보상을 주고 새 씨앗을 심어요.', warn: '한 번 더 물어본 뒤 보상을 바로 줘요.' },
    ],
  },
  {
    id: '8-3',
    title: '양분 조정하고 참여 살펴보기',
    goal: '반 전체를 칭찬할 때 양분을 더하고, 학생마다 보탠 양분을 살펴봐요.',
    steps: [
      menu('tree', '나무 양분 조정은'),
      { tab: 'tree', target: '[data-tour="tree-view"]', area: ['@target'], peek: true, title: '나무 보기',
        text: '나무가 자란 **단계**와 목표까지의 **진행률**을 봐요.', missing: '아직 나무를 심지 않았어요. 도움말 8-1로 먼저 시작해 주세요.' },
      { tab: 'tree', target: '[data-tour="tree-stats"]', area: ['@target'], peek: true, title: '양분과 오늘',
        text: '쌓인 **양분**과 **오늘 양분 준 학생** 수를 봐요.', missing: '아직 나무를 심지 않았어요. 도움말 8-1로 먼저 시작해 주세요.' },
      { tab: 'tree', target: '#tree-feed-amount', area: ['@field', '[data-tour="tree-adjust"] [role="group"][aria-label="자주 쓰는 값"]'], focus: true, title: '양분 조정',
        text: '반 전체를 칭찬할 때 **양분**을 더하고, 잘못 쌓인 양분은 빼요. 바꿀 양을 적거나 아래 버튼으로 고르세요.',
        missing: '아직 나무를 심지 않았어요. 도움말 8-1로 먼저 시작해 주세요.' },
      { tab: 'tree', target: '#tree-feed-note', focus: true, look: true, title: '메모 (선택)', text: '왜 조정하는지 **메모**를 남겨요.', sub: '예: 모둠 활동 칭찬' },
      { tab: 'tree', target: '[data-tour="tree-adjust-buttons"]', area: ['@target'], title: '더하기, 빼기',
        text: '[양분 더하기] 또는 [양분 빼기]를 누르세요.', warn: '누르면 학생 화면의 나무에 바로 반영돼요.' },
      { tab: 'tree', target: '[data-tour="tree-contrib"]', area: ['@target'], peek: true, title: '함께 키운 학생',
        text: '학생마다 **양분 주기**와 **과제**로 보탠 양분, 오늘 준 횟수를 봐요.', sub: '학생 화면에는 순위를 보여 주지 않아요.' },
    ],
  },
  {
    id: '9-1',
    title: '매점, 은행 화면 열고 공유하기',
    goal: '바로가기에서 학생 화면을 새 탭으로 열거나, 주소나 QR 포스터로 다른 기기에 보내요.',
    steps: [
      { target: ['[data-tour="sidebar-shortcuts"] a[href]', '[data-tour="header-shortcuts"] a[href]'], area: ['[data-tour="sidebar-shortcuts"]', '[data-tour="header-shortcuts"]'], peek: true, title: '바로가기',
        text: '학생이 쓰는 **매점, 은행** 화면은 **바로가기**에서 열고 공유해요.',
        sub: '컴퓨터에서는 메뉴 아래, 휴대폰에서는 화면 맨 위에 있어요. 매점, 은행 버튼은 이 기기에서 학생 화면을 새 탭으로 열고, 공유 버튼은 다른 기기에서 열 수 있게 주소와 QR을 보여 줘요.' },
      { target: ['[aria-label="은행 공유"]', '[aria-label="공유"]'], area: [{ closest: '.flex' }], title: '공유 창 열기',
        text: '은행 옆 **공유** 버튼을 누르세요.', next: { wait: '[aria-label="공유할 페이지"]' }, advanceWhen: '[aria-label="공유할 페이지"]' },
      { target: '[aria-label="공유할 페이지"]', area: ['@target'], title: '공유할 화면', text: '공유할 화면을 고르세요: **매점, 은행, 관리자 페이지**',
        sub: '관리자 페이지 주소는 함께 관리하는 선생님에게만 보내요.' },
      { target: '[data-tour="share-copy"]', area: ['[data-tour="share-address"]'], look: true, title: '주소 보내기', text: '[주소 복사]로 주소를 복사해 메신저 등으로 보내요.' },
      { target: '[data-tour="share-pdf"]', area: ['@footer'], look: true, title: 'QR 포스터',
        text: '[PDF로 저장], [이미지로 저장]으로 QR 포스터를 만들어 교실에 붙여요.', sub: '학생이 휴대폰이나 태블릿 카메라로 찍으면 화면이 바로 열려요.' },
    ],
  },
];

export const tutorialById = (id: string) => TUTORIALS.find((tutorial) => tutorial.id === id) ?? null;

/** The tutorial for a teacher who has never used CRS. */
export const FIRST_TUTORIAL_ID = '0-1';

export type TutorialPlace = Readonly<{ ledgerMode: boolean; classList: boolean }>;

/** Whether this class can run the tutorial (the task ledger, the way to the class list). */
export function tutorialUsable(tutorial: Tutorial, place: TutorialPlace): boolean {
  return (!tutorial.ledger || place.ledgerMode) && (place.classList || !tutorial.steps.some((step) => step.opensPage));
}

/** What to offer when the tutorial is done: its own suggestion, or the next usable one. */
export function tutorialAfter(tutorial: Tutorial, place: TutorialPlace): Tutorial | null {
  const suggested = tutorial.then ? tutorialById(tutorial.then) : null;
  if (suggested && tutorialUsable(suggested, place)) return suggested;
  const at = TUTORIALS.indexOf(tutorial);
  return TUTORIALS.slice(at + 1).find((candidate) => tutorialUsable(candidate, place)) ?? null;
}

/** The guide's table of contents (admin chapters); a section with a tutorial can be started. */
export const TUTORIAL_CHAPTERS: ReadonlyArray<Readonly<{ no: number; title: string; items: ReadonlyArray<readonly [string, string]> }>> = [
  { no: 0, title: '처음 시작하기', items: [['0-1', '딴쌤 클래스 한 바퀴 둘러보기']] },
  { no: 1, title: '시작하기', items: [['1-1', '내 학급 열기'], ['1-2', '관리자 화면 둘러보기']] },
  { no: 2, title: '학급 설정', items: [['2-1', '매점, 은행 이름과 화폐 단위 정하기'], ['2-2', '글꼴 바꾸기']] },
  { no: 3, title: '학생 관리', items: [['3-1', '학생 한 명씩 추가하기'], ['3-2', '엑셀로 여러 학생 한꺼번에 추가하기'], ['3-3', '학생 정보 고치기, 이용 멈추기, 삭제하기'],
    ['3-4', '여러 학생을 골라 한꺼번에 처리하기'], ['3-5', '학생 QR 카드 인쇄하기'], ['3-6', '보관함에 아이템 넣기, 사용 처리하기'],
    ['3-7', '모둠 만들고 학생 넣기']] },
  { no: 4, title: '매점 관리', items: [['4-1', '매점에 상품 추가하기'], ['4-2', '상품 고치기, 판매 멈추기, 지우기'], ['4-3', '할인 행사 만들기'], ['4-4', '행사 고치기, 끄기, 지우기']] },
  { no: 5, title: '과제 관리', items: [['5-0', '과제 단계 이해하기'], ['5-1', '새 과제 만들기'], ['5-2', '반복 과제 정하기'], ['5-3', '학생에게 과제 내주기'], ['5-4', '학생 단계 바꾸기, 현황 보기'],
    ['5-5', 'QR로 과제 단계 바꾸기'], ['5-6', '여러 과제를 골라 한꺼번에 처리하기'], ['5-7', '과제를 패들렛 게시판과 연결하기'],
    ['5-8', '패들렛 글이 어떻게 반영됐는지 보기'], ['5-9', '여러 과제를 한 게시판에 연결하기'], ['5-10', '과제를 딴쌤 보드와 연결하기']] },
  { no: 6, title: '화폐와 거래 내역', items: [['6-1', 'QR로 화폐 지급, 회수하기'], ['6-2', '거래 내역 확인하고 취소하기']] },
  { no: 7, title: '펫 키우기', items: [['7-1', '펫 키우기 켜고 성장 정하기'], ['7-2', '먹이와 이용 시간 정하기'], ['7-3', '졸업 보상과 꾸미기 상점 정하기'], ['7-4', '학생 펫 살펴보고 성장 조정하기']] },
  { no: 8, title: '나무 키우기', items: [['8-1', '나무 키우기 켜고 목표 정하기'], ['8-2', '수확 보상과 예상 기간 정하기'], ['8-3', '양분 조정하고 참여 살펴보기']] },
  { no: 9, title: '화면 열기와 공유', items: [['9-1', '매점, 은행 화면 열고 공유하기']] },
];

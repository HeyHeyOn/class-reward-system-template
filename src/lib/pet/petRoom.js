/* 펫 방 엔진: 견본에서 확정한 생활 공간(돌아다니기·일상 행동·감정 말풍선·꾸미기)에, 앱에서 더한 것들
   (여러 마리가 함께 지내기, 손으로 쓰다듬기, 공놀이 쉬는 시간, 햄스터 쳇바퀴, 펫 장식)을 얹은 것. 타입은 petRoom.d.ts. */
/* 펫 생활 공간: 방 한 칸(80×48칸)에서 펫이 최대 세 마리까지 함께 지낸다. 펫은 스스로 돌아다니고, 먹고 마시고,
   혼자 공을 굴리며 놀고, 쉬고 자며, 말풍선으로 기분을 보인다. 학생은 방을 직접 만지지 않는다: 할 수 있는 것은
   버튼으로 먹이 주기·쓰다듬기·놀아 주기뿐이고, 모두 방에 있는 모든 펫에게 한꺼번에 닿는다.
   펫 그림은 PETS(petSprites.js)의 24×24칸 그림을 그대로 쓴다. 그림은 머리가 왼쪽이라 그대로 두면 왼쪽을 보고,
   오른쪽으로 갈 때는 좌우를 뒤집는다. 12fps. 앞뒤(y)가 있어서 아래쪽(앞)에 있는 것이 위에 그려진다. */
const ROOM = (() => {
  const W = 80, H = 48, FLOOR = 28;
  const Y_MIN = 38, Y_MAX = 46, X_MIN = 9, X_MAX = 71; // 펫 발이 닿을 수 있는 바닥
  const BED = { x: 14, y: 37, w: 24 }; // 침대: 가운데 x, 맨 아래 줄 y(벽에 붙여 둠)
  const BED_SPOTS = [{ x: 14, y: 35 }, { x: 8, y: 35 }, { x: 20, y: 35 }]; // 침대 방석 위(발 줄이 앞 테두리에 살짝 가려진다)
  const BOWL = { x: 57, y: 46 }, WATER = { x: 69, y: 46 }; // 먹이통·물그릇(앞쪽 오른편)
  const EAT_SPOTS = [{ x: 53, y: 44, dir: 1 }, { x: 62, y: 43, dir: -1 }, { x: 51, y: 41, dir: 1 }]; // 먹이통 둘레
  const SUN = { x: 58, y: 38 }; // 창문 햇빛이 드는 자리
  const EGG = { x: 24, y: 46 }; // 알은 앞쪽 왼편 바닥에 둔다(돌아다니는 펫에 가려지지 않게)
  const WHEEL = { x: 38, y: 26, r: 9 }; // 햄스터 쳇바퀴(가운데·반지름): 방에 햄스터가 있을 때만 벽 앞에 놓인다
  const BALL_HOME = { x: 44, y: 44 }; // 공은 늘 방에 있다(펫이 혼자 굴리며 논다)
  /* 공놀이 쉬는 시간: 학생이 짧은 사이에 여러 번 놀아 주면 한동안 공에 흥미를 잃는다(실제 시간) */
  const BALL_PLAYS = 3, BALL_WINDOW_MS = 20 * 60_000, BALL_REST_MS = 10 * 60_000;
  /* 쓰다듬기: 짧은 사이에 여러 번이면 당황하고, 더 하면 화낸다(실제 시간) */
  const PAT_WINDOW_MS = 30_000;

  const mixc = (a, b, t) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clampX = (x) => Math.max(X_MIN, Math.min(X_MAX, x));
  const clampY = (y) => Math.max(Y_MIN, Math.min(Y_MAX, y));

  /* ---------- 꾸미기 아이템(펫 상점) ----------
     칸마다 기본 물건 하나(base, 모든 학생이 처음부터 가짐)와 나머지. 값은 정해 두지 않는다:
     학급마다 화폐 크기가 달라서 교사가 물건마다 직접 값을 넣고, 값을 넣은 물건만 상점에 나온다. */
  const DECOR = {
    wall: [{ id: 'cream', name: '크림 벽지', base: true }, { id: 'mint', name: '민트 줄무늬' }, { id: 'sky', name: '하늘 물방울' }, { id: 'pink', name: '분홍 체크' }, { id: 'night', name: '밤하늘' }],
    rug: [{ id: 'pink', name: '분홍 러그', base: true }, { id: 'blue', name: '파랑 동그라미' }, { id: 'leaf', name: '풀잎 러그' }, { id: 'rainbow', name: '무지개 러그' }],
    bed: [{ id: 'basic', name: '나무 방석 침대', base: true }, { id: 'cloud', name: '구름 방석' }, { id: 'mint', name: '민트 방석' }, { id: 'royal', name: '왕실 방석' }],
    plant: [{ id: 'pot', name: '초록 화분', base: true }, { id: 'cactus', name: '선인장' }, { id: 'sunflower', name: '해바라기' }],
    frame: [{ id: 'tree', name: '나무 그림', base: true }, { id: 'heart', name: '하트 그림' }, { id: 'star', name: '별 그림' }],
    toy: [{ id: 'none', name: '장난감 없음', base: true }, { id: 'yarn', name: '털실 뭉치' }, { id: 'duck', name: '고무 오리' }, { id: 'blocks', name: '쌓기 블록' }],
  };
  const DECOR_SLOTS = { wall: '벽지', rug: '러그', bed: '침대', plant: '화분', frame: '액자', toy: '장난감' };
  const DEFAULT_DECOR = { wall: 'cream', rug: 'pink', bed: 'basic', plant: 'pot', frame: 'tree', toy: 'none' };
  /* 상점 미리 보기 카드에 잘라 보여 줄 자리 [x, y, 너비, 높이] */
  const DECOR_CROP = { wall: [22, 0, 26, 26], rug: [18, 34, 44, 14], bed: [0, 27, 28, 12], plant: [64, 14, 16, 18], frame: [5, 3, 19, 15], toy: [0, 38, 14, 10] };

  function wallColor(id, x, y) {
    switch (id) {
      case 'mint': return x % 8 < 2 ? '#cbe6d6' : '#e2f2e8';
      case 'sky': return y % 5 === 2 && (x + (Math.floor(y / 5) % 2) * 3) % 6 === 0 ? '#bcd8f2' : '#e4f0fb';
      case 'pink': return x % 8 === 0 || y % 8 === 0 ? '#f6d2d9' : '#fce8ec';
      case 'night': { const h = (Math.imul(x + 11, 2654435761) ^ Math.imul(y + 3, 2246822519)) >>> 0; const k = (h >>> 7) % 53; return k === 0 ? '#ffe28a' : k < 3 ? '#8f9ccc' : '#34406e'; }
      default: return x % 6 === 0 ? '#eddcca' : '#f3e5d6';
    }
  }
  function rugColor(id, x, y, e) {
    switch (id) {
      case 'blue': return e > 0.8 ? '#5f97c6' : Math.floor(Math.sqrt(e) * 5) % 2 ? '#a9d0ee' : '#c6e1f6';
      case 'leaf': return e > 0.74 ? '#7fb069' : (x + y * 2) % 9 === 0 ? '#d5ebc0' : '#b5d99c';
      case 'rainbow': return e > 0.82 ? '#9b7bb8' : ['#f28b82', '#fbbc66', '#fde68a', '#a8d5a2', '#9cc7e8', '#c3a6e0'][Math.max(0, Math.min(5, Math.floor((y - 36) / 2)))];
      default: return e > 0.74 ? '#d48a91' : (x * 2 + y) % 7 === 0 ? '#f2cdd0' : '#e8b4b8';
    }
  }
  const put = (g, rows, key, ox, oy) => rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== '.' && key[ch] && g[oy + y] && ox + x >= 0 && ox + x < W) g[oy + y][ox + x] = key[ch]; }));
  const PLANTS = {
    pot: { rows: ['...g...', '..d.g..', '.g.d.g.', '..g.d..', 'd..g..d', '.gd.gg.', '...d...'], key: { g: '#6abf69', d: '#4c9a4f' }, x: 71 },
    cactus: { rows: ['...g...', '..gGg..', 'g.gGg..', 'g.gGg.g', 'gggGg.g', '..gGggg', '..gGg..', '..gGg..'], key: { g: '#5aa05a', G: '#7cc47a' }, x: 71 },
    sunflower: { rows: ['.yyy.', 'yybyy', 'ybbby', 'yybyy', '.yyy.', '..g..', '.gg..', '..g.g', '..gg.', '..g..'], key: { y: '#ffcd38', b: '#8a5a2b', g: '#5aa05a' }, x: 72 },
  };
  const FRAMES = {
    tree: { bg: (y) => (y > 12 ? '#9ccc65' : '#e3f4ff'), rows: ['..ggg..', '.ggggg.', '..ggg..', '...t...', '...t...'], key: { g: '#66bb6a', t: '#8d6e63' }, x: 11, y: 8 },
    heart: { bg: () => '#fde4ea', rows: ['.rr.rr.', 'rrrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...'], key: { r: '#ef5b7a' }, x: 11, y: 8 },
    star: { bg: () => '#2f3a66', rows: ['...y...', '...y...', 'yyyyyyy', '.yyyyy.', '..yyy..', '.yy.yy.', '.y...y.'], key: { y: '#ffd54f' }, x: 11, y: 7 },
  };

  /* ---------- 방(배경). 꾸미기가 바뀔 때만 다시 그림 ---------- */
  function background(decor) {
    const g = Array.from({ length: H }, () => new Array(W).fill('#f3e5d6'));
    for (let y = 0; y < 26; y++) for (let x = 0; x < W; x++) g[y][x] = wallColor(decor.wall, x, y); // 벽지
    for (let x = 0; x < W; x++) { g[26][x] = '#c9a27e'; g[27][x] = '#a9805d'; } // 걸레받이
    for (let y = FLOOR; y < H; y++) for (let x = 0; x < W; x++) { // 마룻바닥
      const plank = Math.floor((y - FLOOR) / 4);
      let c = plank % 2 ? '#d7a36f' : '#dcab79';
      if ((y - FLOOR) % 4 === 3) c = '#c38e5b';
      else if ((x + plank * 13) % 27 === 0) c = '#c99460';
      g[y][x] = c;
    }
    // 창문(하늘·구름·창살)
    for (let y = 4; y <= 18; y++) for (let x = 50; x <= 69; x++) {
      const edge = y === 4 || y === 18 || x === 50 || x === 69, bar = x === 59 || x === 60 || y === 11;
      g[y][x] = edge ? '#8d6e63' : bar ? '#a1887f' : y < 8 ? '#a6d6fa' : y < 12 ? '#c2e4fc' : '#dcf0fd';
    }
    for (const [x, y] of [[53, 7], [54, 6], [55, 6], [56, 7], [52, 8], [53, 8], [54, 8], [55, 8], [56, 8], [57, 8], [63, 14], [64, 13], [65, 13], [66, 14], [62, 15], [63, 15], [64, 15], [65, 15], [66, 15], [67, 15]]) g[y][x] = '#ffffff';
    for (let x = 49; x <= 70; x++) { g[19][x] = '#a1887f'; g[20][x] = '#8d6e63'; } // 창턱
    // 액자 — 침대 위 벽
    const fr = FRAMES[decor.frame] || FRAMES.tree;
    for (let y = 6; y <= 15; y++) for (let x = 8; x <= 20; x++) g[y][x] = y === 6 || y === 15 || x === 8 || x === 20 ? '#9c6b3c' : fr.bg(y);
    put(g, fr.rows, fr.key, fr.x, fr.y);
    // 화분(오른쪽 구석): 화분은 같고 위에 심은 것만 다르다
    const pl = PLANTS[decor.plant] || PLANTS.pot;
    put(g, pl.rows, pl.key, pl.x, 24 - pl.rows.length); // 맨 아랫줄이 화분 바로 위
    for (let y = 24; y <= 30; y++) for (let x = 71 + (y > 27 ? 1 : 0); x <= 77 - (y > 27 ? 1 : 0); x++) g[y][x] = y === 24 ? '#a85d30' : y === 30 ? '#8e4b24' : '#c0703f';
    // 러그(가운데 타원)
    for (let y = 36; y <= 46; y++) for (let x = 20; x <= 60; x++) {
      const e = ((x - 40) / 19.5) ** 2 + ((y - 41) / 5.2) ** 2;
      if (e <= 1) g[y][x] = rugColor(decor.rug, x, y, e);
    }
    // 창문 햇빛(바닥에 비스듬히)
    for (let y = 29; y <= 40; y++) {
      const shift = (y - 28) * 0.9;
      for (let x = Math.round(50 - shift); x <= Math.round(66 - shift); x++) if (x >= 0 && x < W) g[y][x] = mixc(g[y][x], '#fff3b8', 0.32);
    }
    return g;
  }

  /* ---------- 물건 ---------- */
  function bedRows(w) {
    const mid = (a, b, c) => a + b.repeat(w - a.length * 2) + c;
    return [mid('...', 'o', '...'), mid('.oo', 'r', 'oo.'), mid('or', 'R', 'ro'), mid('oR', 'c', 'Ro'), mid('oR', 'c', 'Ro'), mid('oR', 'C', 'Ro'),
      mid('oRr', 'r', 'rRo'), mid('.oR', 'R', 'Ro.'), mid('..o', 'o', 'o..')];
  }
  const BED_ROWS = bedRows(BED.w);
  const BED_KEYS = {
    basic: { o: '#6d4c41', R: '#b9855f', r: '#d29d74', c: '#f6c6cf', C: '#e9aab6' },
    cloud: { o: '#4f6b8a', R: '#8fb8de', r: '#b5d3ee', c: '#ffffff', C: '#e3eef8' },
    mint: { o: '#3f6b55', R: '#7fc4a0', r: '#a8dcc0', c: '#fff6e0', C: '#f0e3c2' },
    royal: { o: '#4a2f6b', R: '#8e5cc2', r: '#b48ade', c: '#ffe08a', C: '#f2c94c' },
  };
  const TOY = { x: 6, y: 46 }; // 침대 앞 왼쪽 바닥(발 줄 y)
  const TOYS = {
    yarn: { rows: ['.ppp..', 'pPpPp.', 'ppPpp.', '.ppppp'], key: { p: '#e57399', P: '#f6a5bf' } },
    duck: { rows: ['.YY...', 'aeY...', '.YYY.Y', '.YYYYY', '..DDD.'], key: { Y: '#ffd54f', e: '#3b2a1a', a: '#ff8f3a', D: '#e6b432' } },
    blocks: { rows: ['..rr..', '..rR..', 'bbbggg', 'bBbgGg', 'bbbggg'], key: { r: '#ef5350', R: '#ff8a80', b: '#42a5f5', B: '#90caf9', g: '#66bb6a', G: '#a5d6a7' } },
  };
  const BOWL_KEY = { o: '#7a2a1a', y: '#d84a36', Y: '#ef6c57', k: '#7a4a24' };
  const WATER_KEY = { o: '#455a64', g: '#90a4ae', G: '#b0bec5', b: '#6fc0ee', B: '#bfe6fb' };
  const BALL = ['.rr.', 'rwrr', 'rrrr', '.rr.'], BALL_KEY = { r: '#ef5350', w: '#ffffff' };
  /* 쓰다듬는 손(손가락이 아래로, 머리를 토닥인다) */
  const HAND = ['...oooo...', '..oSSSSo..', '.oSSSSSSo.', 'oSoSSSSSo.', 'o.oSHSSSo.', '..oSoSoSo.', '..oSoSoSo.', '...o.o.o..'], HAND_KEY = { o: '#8a5638', S: '#ffd9b8', H: '#fff1e4' };

  /* ---------- 떠오르는 작은 것들 ---------- */
  const GLYPH = {
    heart: { rows: ['h.h', 'hhh', '.h.'], key: { h: '#ff5c8a' } },
    note: { rows: ['.qq', '.q.', 'qq.', 'qq.'], key: { q: '#5c6bc0' } },
    spark: { rows: ['.s.', 'sSs', '.s.'], key: { s: '#ffcc33', S: '#fff8c4' } },
    drop: { rows: ['.b.', 'bbb', 'bbb'], key: { b: '#64b5f6' } },
    dot: { rows: ['d'], key: {} }, // 색은 그때그때(흙·털)
  };

  /* ---------- 말풍선(감정) ---------- */
  const BUBBLE = ['.ooooooo.', 'oWWWWWWWo', 'oWWWWWWWo', 'oWWWWWWWo', 'oWWWWWWWo', 'oWWWWWWWo', '.ooWoooo.', '..oWo....', '...o.....'];
  const ICONS = {
    love: ['.h.h.', 'hhhhh', 'hhhhh', '.hhh.', '..h..'],
    happy: ['..qq.', '..q.q', '..q..', 'qqq..', 'qq...'],
    excited: ['..s..', '.sSs.', 'sSSSs', '.sSs.', '..s..'],
    surprise: ['..r..', '..r..', '..r..', '.....', '..r..'],
    curious: ['.qqq.', '...q.', '..q..', '.....', '..q..'],
    hungry: ['..k..', '.kkk.', 'yyyyy', '.yyy.', '.....'],
    sleepy: ['zzzz.', '..z..', '.z...', 'zzzz.', '.....'],
    bored: ['.....', '.....', 'g.g.g', '.....', '.....'],
    meh: ['.....', 'gg.gg', '.....', '.ggg.', '.....'],
    sweat: ['..b..', '.bbb.', 'bbbbb', 'bbbbb', '.bbb.'],
    sad: ['g...g', 'b...b', '.....', '.ggg.', 'g...g'],
    angry: ['r...r', '.r.r.', '.....', '.rrr.', 'r...r'],
  };
  const ICON_KEY = { h: '#ff5c8a', q: '#5c6bc0', r: '#e53935', g: '#6d6a75', b: '#42a5f5', k: '#8d6e63', y: '#ef6c57', z: '#5c6bc0', s: '#ffb300', S: '#ffe082' };
  /* 화면에 보이는 펫 상태는 행동이 아니라 감정·상태 한 낱말 */
  const EMOTES = { love: '행복함', happy: '기쁨', excited: '신남', surprise: '놀람', curious: '궁금함', hungry: '배고픔', sleepy: '졸림', bored: '심심함', sweat: '당황함', sad: '슬픔', angry: '화남', meh: '시큰둥함' };

  /* ---------- 종마다 다른 걸음새 ----------
     speed: 한 프레임에 가는 칸 · stepEvery: 발을 바꾸는 프레임 · bob: 발 바꿀 때 몸이 들썩
     hop: 뛰어서 가는 동물(높이 줄, 한 번에 가는 칸, 쉬는 프레임) · burst: 가다 서다(가는 프레임, 서는 프레임) */
  const GAITS = {
    dog: { speed: 0.85, stepEvery: 2, bob: true, label: '총총' },
    cat: { speed: 0.65, stepEvery: 2, bob: false, label: '사뿐사뿐' },
    rabbit: { hop: [-1, -2, -3, -3, -2, -1], hopDist: 8, rest: 2, label: '깡충깡충' },
    hamster: { speed: 1.1, stepEvery: 1, bob: true, burst: [16, 4], label: '종종종' },
    canary: { hop: [-1, -2, -2, -1], hopDist: 5, rest: 1, flap: true, label: '콩콩' },
    turtle: { speed: 0.22, stepEvery: 3, bob: false, label: '느릿느릿' },
    lizard: { speed: 1.7, stepEvery: 1, bob: false, burst: [8, 8], label: '후다닥' },
  };
  const SPECIALS = {
    dog: { id: 'zoom', name: '우다다 뛰기' }, cat: { id: 'groom', name: '그루밍' }, rabbit: { id: 'binky', name: '빙키(뛰며 몸 비틀기)' },
    hamster: { id: 'wheel', name: '쳇바퀴 타기' }, canary: { id: 'sing', name: '노래하기' }, turtle: { id: 'bask', name: '햇볕 쬐기' }, lizard: { id: 'bask', name: '햇볕 쬐기' },
  };
  const SHAKES = { dog: '몸 털기', cat: '몸 털기', rabbit: '몸 털기', hamster: '몸 털기', canary: '깃털 부풀리기', turtle: '목 쭉 빼기', lizard: '꼬리 흔들기' };
  const DAILY = ['wander', 'look', 'idle', 'lounge', 'yawn', 'shake', 'eat', 'drink', 'play', 'sleep', 'special'];
  const DAILY_NAMES = { wander: '돌아다니기', look: '두리번거리기', idle: '앉아 쉬기', lounge: '엎드려 쉬기', yawn: '하품', shake: '몸 털기', eat: '먹이 먹기', drink: '물 마시기', play: '공놀이', sleep: '잠자기', special: '종마다 특기' };

  /* 펫 기분 한 낱말: 말풍선이 떠 있으면 그 감정, 아니면 하고 있는 일과 배고픔·기운·재미로 */
  const ACTION_MOODS = { play: '신남', run: '신남', binky: '신남', wheel: '신남', eat: '행복함', beg: '배고픔', sing: '기쁨', bask: '편안함', groom: '편안함', petted: '행복함' };

  function create(P, init) {
    const bgCache = new Map();
    const bgOf = (d) => { const k = `${d.wall}|${d.rug}|${d.plant}|${d.frame}`; let g = bgCache.get(k); if (!g) { g = background(d); bgCache.set(k, g); } return g; };
    /* 방 전체가 함께 쓰는 것: 먹이통(먹이 칸 수)·공·떠오르는 것들·꾸미기·이용 시간·쳇바퀴 돌아간 정도 */
    const R = {
      food: 0, ball: { x: BALL_HOME.x, y: BALL_HOME.y, z: 0, vx: 0, vy: 0, vz: 0 }, fx: [], rate: 1, clock: 0, spin: 0,
      decor: { ...DEFAULT_DECOR, ...(init.decor || {}) }, offHours: false,
    };
    const pets = [];
    const hatched = () => pets.filter((p) => p.s.stage > 0);
    const puff = (glyph, x, y, o = {}) => R.fx.push({ glyph, x, y, vx: o.vx || 0, vy: o.vy ?? -0.35, life: o.life || 20, color: o.color, follow: o.follow || null });

    /* ---------- 공(방에 하나) ---------- */
    function throwBall() { R.ball = { x: rnd(X_MIN + 4, X_MAX - 4), y: rnd(Y_MIN, Y_MAX), z: 18, vx: rnd(-0.8, 0.8), vy: 0, vz: 0 }; }
    function ballStep() {
      const b = R.ball;
      b.vz += 0.35; b.z -= b.vz; if (b.z <= 0) { b.z = 0; b.vz = Math.abs(b.vz) > 0.8 ? -Math.abs(b.vz) * 0.45 : 0; }
      b.x += b.vx; b.y += b.vy; b.vx *= b.z > 0 ? 0.98 : 0.92; b.vy *= 0.9;
      if (b.x < X_MIN - 4 || b.x > X_MAX + 4) { b.vx *= -0.8; b.x = Math.max(X_MIN - 4, Math.min(X_MAX + 4, b.x)); }
      b.y = clampY(b.y);
    }
    const wheelBusy = (me) => pets.some((p) => p.s !== me && (p.s.inWheel || p.s.then === 'wheel'));
    const hasWheel = () => pets.some((p) => p.s.stage > 0 && p.s.species === 'hamster');

    /* ---------- 펫 한 마리 ---------- */
    function makePet(spec, slot) {
      const s = {
        id: spec.id, species: spec.species, color: spec.color, stage: spec.stage, acc: spec.accessory || null, slot,
        x: 30 + slot * 14, y: 42 + (slot % 2) * 3, dir: slot % 2 ? 1 : -1, action: 'idle', t: 0, dur: 30, clock: 0,
        target: null, then: null, fly: false, moving: false, hopT: 0, burstT: 0, laps: 0, last: null,
        emote: null, emoteT: 0, react: null, box: null, head: null,
        needs: { hunger: 35, energy: 75, fun: 55 },
        sleepReason: null, pendingSleep: null, // 잠 이유: tired(피곤) · off(이용 시간 밖)
        pats: [], plays: [], boredUntil: 0, inWheel: false, jump: false,
      };
      const later = []; // n프레임 뒤에 할 일
      const pal = () => P.COLORS[s.species].find((c) => c.id === s.color) || P.COLORS[s.species][0];
      const moves = () => P.TAIL_MOVES[s.species];
      const bedSpot = () => BED_SPOTS[s.slot % BED_SPOTS.length];

      const say = (icon, frames = 36) => { s.emote = icon; s.emoteT = frames; };
      const after = (frames, fn) => later.push({ fn, at: s.clock + frames });
      function start(action, dur) { s.action = action; s.t = 0; s.dur = dur || 40; s.moving = false; }
      function go(target, then, opt = {}) {
        s.action = opt.run ? 'run' : 'walk'; s.t = 0; s.then = then;
        s.target = { x: clampX(target.x), y: target.bed ? target.y : clampY(target.y) };
        s.fly = s.species === 'canary' && Math.hypot(s.target.x - s.x, s.target.y - s.y) > 22; // 카나리아는 멀면 날아간다
        s.hopT = 0; s.burstT = 0;
      }
      const eatSpot = () => EAT_SPOTS[s.slot % EAT_SPOTS.length];
      const at = { bowl: () => eatSpot(), water: () => ({ x: WATER.x - 4, y: WATER.y - 2 }), bed: () => ({ ...bedSpot(), bed: true }), sun: () => SUN };
      function leaveWheel() { if (!s.inWheel) return; s.inWheel = false; s.x = WHEEL.x; s.y = Y_MIN; }
      function sleepNow(reason) {
        later.length = 0; s.then = null; leaveWheel(); s.emote = null;
        const spot = bedSpot(); s.x = spot.x; s.y = spot.y; s.dir = -1; s.sleepReason = reason; start('sleep', 9999);
      }

      /* ---------- 할 일 ---------- */
      function doBehavior(name) {
        const sp = SPECIALS[s.species];
        switch (name) {
          case 'wander': go({ x: rnd(X_MIN, X_MAX), y: rnd(Y_MIN, Y_MAX) }, null); break;
          case 'look': start('look', 52); break;
          case 'idle': start('idle', Math.round(rnd(40, 80))); break;
          case 'lounge': start('lounge', Math.round(rnd(90, 150))); break;
          case 'yawn': start('yawn', 30); break;
          case 'shake': start('shake', 22); break;
          case 'eat': go(at.bowl(), 'eat'); break;
          case 'drink': go(at.water(), 'drink'); break;
          case 'play': say('excited', 24); start('play', 150); break;
          case 'sleep': say('sleepy', 30); go(at.bed(), 'sleep'); break;
          case 'special':
            if (sp.id === 'bask') go(at.sun(), 'bask');
            else if (sp.id === 'zoom') { s.laps = 4; say('excited', 24); go({ x: s.x < 40 ? X_MAX : X_MIN, y: s.y }, 'zoom', { run: true }); }
            else if (sp.id === 'wheel') { if (wheelBusy(s)) start('look', 52); else go({ x: WHEEL.x, y: Y_MIN }, 'wheel'); }
            else start(sp.id, { groom: 60, binky: 30, sing: 72 }[sp.id]);
            break;
        }
        s.last = name;
      }

      /* 스스로 다음 할 일 고르기: 배고픔·기운·재미에 따라 */
      function decide() {
        const n = s.needs;
        if (s.stage === 0) { start('idle', 60); return; }
        if (n.energy < 18) { s.pendingSleep = 'tired'; if (s.last !== 'yawn') { doBehavior('yawn'); s.then = 'sleep'; } else doBehavior('sleep'); return; }
        if (R.food > 0 && n.hunger > 30 && s.last !== 'eat') { say('hungry', 24); doBehavior('eat'); return; } // 먹이통에 먹이가 있으면 먹으러 간다
        if (n.hunger > 72 && s.last !== 'eat') { say(R.food > 0 ? 'hungry' : 'sad', 30); doBehavior('eat'); return; }
        if (n.fun < 22 && s.last !== 'bored' && Math.random() < 0.6) { reactTo('bored'); s.last = 'bored'; return; }
        const ballOk = Date.now() >= s.boredUntil;
        const table = [
          ['wander', 32], ['look', 10], ['idle', 12], ['lounge', n.energy < 50 ? 16 : 6], ['yawn', n.energy < 45 ? 8 : 2],
          ['shake', 5], ['drink', n.hunger > 40 ? 8 : 5], ['special', 11], ['play', ballOk && n.fun < 85 && n.energy > 30 ? 12 : 0],
        ].filter(([k]) => k === 'wander' || k !== s.last);
        let r = Math.random() * table.reduce((a, [, w]) => a + w, 0);
        for (const [k, w] of table) { r -= w; if (r <= 0) { doBehavior(k); return; } }
        doBehavior('wander');
      }

      /* 감정 반응: 말풍선 + 몸짓 */
      function reactTo(kind) {
        say(kind, kind === 'surprise' ? 24 : 40);
        if (s.stage === 0) return;
        const dur = { surprise: 14, angry: 30, sad: 48, happy: 30, love: 30, excited: 36, curious: 40, bored: 70, sweat: 26, hungry: 40, sleepy: 34, meh: 30 }[kind] || 30;
        const keep = s.then; start('react', dur); s.react = kind; s.then = keep;
        if (kind === 'love') for (let i = 0; i < 3; i++) after(i * 8, () => puff('heart', s.x + rnd(-4, 3), s.y - 17, { life: 18 }));
        // 땀방울은 말풍선(머리 위)과 겹치지 않게 얼굴 쪽 머리 옆에서 흘러내린다
        if (kind === 'sweat') { const b = s.box; const dx = b ? (s.dir > 0 ? b.x1 + 1 : b.x0 - 3) : s.x - 10; puff('drop', dx, b ? b.y0 + 1 : s.y - 12, { vy: 0.2, life: 14, follow: s }); }
      }

      /* ---------- 걷기 ---------- */
      function moveToward(speedMul = 1) {
        const gait = GAITS[s.species]; const tx = s.target.x, ty = s.target.y;
        const dx = tx - s.x, dy = ty - s.y, dist = Math.hypot(dx, dy);
        if (Math.abs(dx) > 0.5) s.dir = dx < 0 ? -1 : 1;
        if (dist < 0.6) { s.x = tx; s.y = ty; s.moving = false; return true; }
        let speed = 0; s.moving = true;
        if (s.fly) speed = 1.5;
        else if (gait.hop) {
          const len = gait.hop.length + gait.rest, p = s.hopT % len; s.hopT += 1;
          speed = p < gait.hop.length ? gait.hopDist / gait.hop.length : 0; s.moving = p < gait.hop.length;
        } else if (gait.burst && speedMul === 1) {
          const [g, st] = gait.burst, p = s.burstT % (g + st); s.burstT += 1;
          speed = p < g ? gait.speed : 0; s.moving = p < g;
        } else speed = gait.speed;
        speed *= speedMul;
        const k = Math.min(1, speed / dist); s.x += dx * k; s.y += dy * k;
        return false;
      }
      /* 걷는 동안의 들썩임(위로 음수) */
      function walkLift() {
        const gait = GAITS[s.species];
        if (s.fly) return -5 + Math.round(Math.sin(s.clock / 2));
        if (gait.hop) { const len = gait.hop.length + gait.rest, p = (s.hopT - 1 + len) % len; return s.moving && p < gait.hop.length ? gait.hop[p] : 0; }
        if (!s.moving) return 0;
        return gait.bob && Math.floor(s.clock / gait.stepEvery) % 2 ? -1 : 0;
      }
      const stepOf = () => { const gait = GAITS[s.species]; if (gait.hop || !s.moving || s.fly) return 0; return (Math.floor(s.clock / gait.stepEvery) % 2) + 1; };

      function kick() {
        const b = R.ball; const dir = b.x >= s.x ? 1 : -1;
        b.vx = dir * rnd(1.1, 2.0); b.vy = rnd(-0.5, 0.5); b.vz = -rnd(1.2, 2.2); b.z = 0.1;
        puff('spark', b.x - 1, b.y - 4, { life: 8, vy: -0.2 });
        s.needs.fun = Math.min(100, s.needs.fun + 7);
      }

      /* ---------- 한 프레임 진행 ---------- */
      function tick() {
        s.clock += 1; s.t += 1;
        const n = s.needs, rate = R.rate;
        if (s.stage > 0) {
          n.hunger = Math.min(100, n.hunger + 0.02 * rate);
          if (s.action !== 'sleep') n.energy = Math.max(0, n.energy - (s.action === 'run' || s.action === 'play' || s.action === 'wheel' ? 0.12 : s.action === 'binky' ? 0.06 : 0.018) * rate);
          n.fun = Math.max(0, n.fun - 0.025 * rate);
        }
        if (s.emoteT > 0) s.emoteT -= 1; else s.emote = null;
        for (let i = later.length - 1; i >= 0; i--) if (later[i].at <= s.clock) { const it = later[i]; later.splice(i, 1); it.fn(); }
        if (s.stage === 0) { if (s.t > s.dur) start('idle', 60); return; }
        const x0 = s.x, y0 = s.y;
        step();
        for (const p of R.fx) if (p.follow === s) { p.x += s.x - x0; p.y += s.y - y0; }
      }

      function step() {
        const n = s.needs, rate = R.rate;
        switch (s.action) {
          case 'walk': case 'run': {
            const arrived = moveToward(s.action === 'run' ? 2.4 : 1);
            if (s.action === 'run' && s.clock % 3 === 0) puff('dot', s.x + (s.dir > 0 ? -5 : 5), s.y, { vy: -0.15, life: 6, color: '#c49a6c' });
            if (!arrived) break;
            const next = s.then; s.then = null; s.fly = false;
            if (next === 'zoom') {
              s.laps -= 1;
              if (s.laps > 0) { go({ x: s.x < 40 ? X_MAX : X_MIN, y: clampY(s.y + rnd(-3, 3)) }, 'zoom', { run: true }); break; }
              n.fun = Math.min(100, n.fun + 25); reactTo('happy'); break;
            }
            if (next === 'sleep') { s.dir = -1; s.sleepReason = s.pendingSleep || 'tired'; s.pendingSleep = null; start('sleep', 9999); break; }
            if (next === 'eat') { s.dir = eatSpot().dir; if (R.food > 0) start('eat', 999); else start('beg', 110); break; }
            if (next === 'drink') { s.dir = 1; start('drink', 40); break; }
            if (next === 'bask') { start('bask', 110); break; }
            if (next === 'wheel') {
              if (wheelBusy(s)) { start('look', 30); break; }
              s.inWheel = true; s.x = WHEEL.x; s.y = WHEEL.y + WHEEL.r - 1; s.dir = -1; say('excited', 20); start('wheel', Math.round(rnd(80, 120))); break;
            }
            start('idle', Math.round(rnd(20, 50)));
            break;
          }
          case 'sleep':
            n.energy = Math.min(100, n.energy + 0.22 * rate);
            if (s.sleepReason !== 'off' && n.energy >= 100 && s.t * rate > 240) { s.sleepReason = null; start('yawn', 30); s.then = 'wake'; }
            break;
          case 'eat':
            if (s.t % 9 === 0 && R.food > 0) { R.food -= 1; n.hunger = Math.max(0, n.hunger - 15); }
            if (R.food <= 0 || n.hunger <= 0) reactTo('love');
            break;
          case 'beg':
            if (R.food > 0) { reactTo('surprise'); s.then = 'eat-now'; }
            else if (s.t === 30 || s.t === 70) say('hungry', 26);
            else if (s.t > s.dur) reactTo('sad');
            break;
          case 'drink':
            if (s.t > s.dur) { n.hunger = Math.max(0, n.hunger - 3); start('idle', 30); }
            break;
          case 'play': {
            const b = R.ball;
            const side = s.x < b.x ? -1 : 1;
            s.target = { x: clampX(b.x + side * 5), y: clampY(b.y) };
            const near = Math.abs(s.x - s.target.x) < 1.5 && Math.abs(s.y - b.y) < 1.5;
            if (near && b.z < 1 && Math.abs(b.vx) < 0.5) { s.moving = false; s.dir = -side; kick(); if (Math.random() < 0.3) say('excited', 18); }
            else moveToward(1.5);
            if (s.t > s.dur || n.fun >= 100) reactTo('happy');
            break;
          }
          case 'wheel':
            R.spin += 0.32;
            n.fun = Math.min(100, n.fun + 0.12);
            if (s.t > s.dur) { leaveWheel(); n.fun = Math.min(100, n.fun + 8); reactTo('happy'); }
            break;
          case 'petted':
            if (s.t > s.dur) {
              const many = s.pats.length;
              s.needs.energy = Math.max(0, s.needs.energy - 3);
              if (many >= 5) reactTo('angry');
              else if (many >= 3) reactTo('sweat');
              else { s.needs.fun = Math.min(100, s.needs.fun + 8); s.jump = true; reactTo('love'); }
            }
            break;
          case 'react': {
            const k = s.react;
            if (k === 'curious' && s.t % 13 === 0) s.dir *= -1;
            if (k === 'excited' && s.t % 10 === 0 && Math.random() < 0.6) puff('spark', s.x + rnd(-6, 6), s.y - rnd(10, 16), { life: 10, vy: -0.2 });
            if (k === 'sweat' && s.t < 12) s.x = clampX(s.x - s.dir * 0.4); // 뒤로 살짝 물러선다
            if (s.t > s.dur) {
              if (k === 'angry') s.dir *= -1; // 화나면 고개를 돌린다
              s.jump = false;
              const next = s.then; s.then = null;
              if (next === 'eat-now') { start('eat', 999); break; }
              if (next === 'play') { start('play', 150); break; }
              if (next === 'sleep') { doBehavior('sleep'); break; }
              if (next === 'eat') { doBehavior('eat'); break; }
              start('idle', 24);
            }
            break;
          }
          case 'yawn':
            if (s.t > s.dur) {
              const next = s.then; s.then = null;
              if (next === 'sleep') doBehavior('sleep');
              else if (next === 'wake') { reactTo(R.food > 0 ? 'surprise' : 'happy'); if (R.food > 0) s.then = 'eat'; }
              else start('idle', 24);
            }
            break;
          case 'shake':
            if (s.t % 3 === 0 && ['dog', 'cat', 'rabbit', 'hamster', 'canary'].includes(s.species)) puff('dot', s.x + rnd(-7, 7), s.y - rnd(4, 10), { vx: rnd(-0.4, 0.4), vy: -0.2, life: 6, color: pal().f });
            if (s.t > s.dur) start('idle', 20);
            break;
          case 'groom':
            if (s.t > s.dur) { n.fun = Math.min(100, n.fun + 10); reactTo('happy'); }
            break;
          case 'binky':
            if (s.t === 1) say('excited', 30);
            if (s.t === 4 || s.t === 15) s.dir *= -1; // 공중에서 몸을 비튼다
            if (s.t > s.dur) { n.fun = Math.min(100, n.fun + 15); start('idle', 20); }
            break;
          case 'sing':
            if (s.t % 10 === 0) puff('note', s.x + (s.dir > 0 ? 4 : -6), s.y - 14, { vx: (s.dir > 0 ? 1 : -1) * 0.15, vy: -0.35, life: 18 });
            if (s.t > s.dur) { n.fun = Math.min(100, n.fun + 12); reactTo('happy'); }
            break;
          case 'bask':
            n.energy = Math.min(100, n.energy + 0.04 * rate);
            if (s.t % 16 === 0) puff('spark', s.x + rnd(-6, 6), s.y - rnd(12, 18), { life: 10, vy: -0.1 });
            if (s.t > s.dur) reactTo('happy');
            break;
          case 'look':
            if (s.t % 13 === 0) s.dir *= -1;
            if (s.t === 26 && Math.random() < 0.4) say('curious', 24);
            if (s.t > s.dur) start('idle', 20);
            break;
          default: // idle, lounge
            if (s.action === 'lounge') n.energy = Math.min(100, n.energy + 0.03 * rate);
            if (s.t > s.dur) decide();
        }
      }

      /* ---------- 지금 모습(24×24칸) ---------- */
      function frame(acc) {
        const sp = s.species, st = s.stage, c = s.color, t = s.t, f = s.clock;
        const base = { noPerch: true, acc: acc === undefined ? s.acc : acc };
        const draw = (opt) => P.draw(sp, st, c, { ...base, ...opt });
        const extras = (k) => P.happyExtras(sp, k);
        if (st === 0) return { grid: P.scene(sp, 0, c, 'idle', s.t + 40), dy: 0 };
        switch (s.action) {
          case 'walk': case 'run': {
            const run = s.action === 'run';
            const gait = GAITS[sp];
            const lift = walkLift();
            const flap = gait.flap && (s.fly ? f % 2 === 0 : lift < -1);
            return { grid: draw({ pose: 'walk', step: run ? (f % 2) + 1 : stepOf(), flap, happy: run, wag: run ? moves().happy(f) : moves().calm(f) }), dy: run ? (f % 2 ? -1 : 0) : lift };
          }
          case 'play': {
            const lift = s.moving ? walkLift() : 0;
            return { grid: draw({ ...extras(f), pose: 'walk', step: s.moving && !GAITS[sp].hop ? (f % 2) + 1 : 0, happy: true, wag: moves().happy(f) }), dy: lift };
          }
          case 'wheel': return { grid: draw({ pose: 'walk', step: (f % 2) + 1, happy: true, sniff: f % 8 < 2 }), dy: f % 2 ? -1 : 0, noShadow: true };
          case 'sleep': return { grid: P.scene(sp, st, c, 'sleep', f, base), dy: 0, noFlip: true, inBed: true };
          case 'lounge': return { grid: draw({ pose: 'sleep', awake: true, closed: f % 60 >= 54 && f % 60 < 57 }), dy: 0 };
          case 'eat': return { grid: draw({ closed: t % 6 < 3, puff: sp === 'hamster' && t > 8, tongue: sp === 'lizard' && t % 6 < 2, wag: moves().still(f) }), dy: t % 6 < 3 ? 1 : 0 };
          case 'beg': return { grid: draw({ wag: moves().calm(f) }), dy: sp === 'dog' || sp === 'rabbit' || sp === 'canary' ? (t % 20 < 2 ? -1 : 0) : 0 };
          case 'drink': return { grid: draw({ closed: true, tongue: sp === 'lizard' && t % 4 < 2, wag: moves().still(f) }), dy: t % 8 < 4 ? 1 : 0 };
          case 'yawn': { const open = t > 4 && t < 20; return { grid: draw({ closed: t > 2 && t < 24, yawn: open }), dy: open ? -1 : 0 }; }
          case 'shake': {
            if (sp === 'turtle') return { grid: draw({}), dy: t % 12 < 6 ? -1 : 0, dx: t % 12 < 6 ? -1 : 0 };
            if (sp === 'lizard') return { grid: draw({ wag: moves().happy(f) }), dy: 0 };
            if (sp === 'canary') return { grid: draw({ flap: t % 2 === 0, closed: true }), dy: 0, dx: t % 2 ? 1 : 0 };
            return { grid: draw({ closed: true, wag: moves().happy(f) }), dy: 0, dx: t % 2 ? 1 : -1 };
          }
          case 'groom': return { grid: draw({ closed: true, happy: t > 30, step: t % 16 < 8 ? 1 : 0, wag: moves().calm(f) }), dy: t % 16 < 8 ? 0 : 1 };
          case 'binky': { const h = [0, -2, -4, -5, -5, -4, -2, 0, 0, 0, 0, -2, -4, -5, -5, -4, -2, 0]; return { grid: draw({ ...extras(f), happy: true, closed: true, wag: moves().happy(f) }), dy: h[t % h.length] || 0 }; }
          case 'sing': return { grid: draw({ flap: Math.floor(t / 3) % 2 === 0, happy: true, closed: Math.floor(t / 10) % 2 === 1 }), dy: Math.floor(t / 5) % 2 ? -1 : 0 };
          case 'bask': return { grid: draw({ pose: sp === 'lizard' ? 'sleep' : 'sit', awake: true, closed: true, happy: true, tongue: sp === 'lizard' && t % 40 < 3 }), dy: 0 };
          // 손이 머리를 토닥이는 동안: 눈을 감고, 손이 누를 때 머리가 살짝 내려간다
          case 'petted': return { grid: draw({ closed: true, happy: t > 6, wag: moves().happy(f) }), dy: t % 8 < 4 ? 1 : 0, hand: true };
          case 'react': {
            const k = s.react;
            if (k === 'surprise') return { grid: draw({ wag: moves().happy(f) }), dy: [0, -2, -3, -3, -2, -1, 0][Math.min(6, t)] || 0 };
            if (k === 'angry') return { grid: draw({ closed: t > 14, wag: 0 }), dy: 0, dx: t < 14 ? (t % 2 ? 1 : -1) : 0 };
            if (k === 'sad') return { grid: draw({ closed: Math.floor(t / 12) % 2 === 1, wag: 0 }), dy: 1 };
            if (k === 'happy') return { grid: draw({ ...extras(f), happy: true, closed: true, wag: moves().happy(f) }), dy: t < 12 ? P.hopOf(sp, t) : 0 };
            if (k === 'love') {
              // 쓰다듬어 준 뒤에는 좋아서 두 번 펄쩍 뛴다(거북이는 끄덕)
              const jump = sp === 'turtle' ? [0, 0, -1, -1, 0, 0, 0, 0] : [0, -2, -4, -5, -5, -4, -2, 0];
              const dy = s.jump ? (t < 16 ? jump[t % 8] : 0) : (t % 12 < 6 ? P.hopOf(sp, t) : 0);
              return { grid: draw({ ...extras(f), happy: true, closed: true, wag: moves().happy(f) }), dy };
            }
            if (k === 'excited') return { grid: draw({ ...extras(f), happy: true, wag: moves().happy(f) }), dy: P.hopOf(sp, t) };
            if (k === 'curious') return { grid: draw({ sniff: true, wag: moves().calm(f) }), dy: 0 };
            if (k === 'bored') return { grid: draw({ pose: 'sleep', awake: true, closed: t % 30 >= 24 }), dy: 0 };
            if (k === 'meh') return { grid: draw({ closed: t % 16 < 10, wag: 0 }), dy: 0 };
            if (k === 'sweat') return { grid: draw({ closed: t % 10 < 5 }), dy: 0 };
            if (k === 'hungry') return { grid: draw({ wag: moves().calm(f) }), dy: t % 14 < 2 ? -1 : 0 };
            if (k === 'sleepy') return { grid: draw({ closed: true, yawn: t > 4 && t < 18 }), dy: t > 18 ? 1 : 0 };
            return { grid: draw({}), dy: 0 };
          }
          default: return { grid: P.scene(sp, st, c, 'idle', f, base), dy: 0 };
        }
      }

      const awake = () => s.stage > 0 && s.action !== 'sleep' && !R.offHours;
      const tired = () => s.needs.energy < 25;

      function mood() {
        if (s.stage === 0) return '두근두근';
        if (s.action === 'sleep') return '꿈나라';
        if (s.emote && EMOTES[s.emote]) return EMOTES[s.emote];
        if (ACTION_MOODS[s.action]) return ACTION_MOODS[s.action];
        const n = s.needs;
        if (n.hunger > 70) return '배고픔';
        if (n.energy < 25) return '졸림';
        if (n.fun < 22) return '심심함';
        if (n.fun > 75) return '기쁨';
        return '편안함';
      }

      return {
        s, tick, frame, mood, sleepNow, leaveWheel,
        set(o) {
          const reset = (o.stage !== undefined && o.stage !== s.stage) || (o.species && o.species !== s.species);
          const grew = o.stage !== undefined && o.stage > s.stage;
          if (o.species !== undefined) s.species = o.species;
          if (o.color !== undefined) s.color = o.color;
          if (o.stage !== undefined) s.stage = o.stage;
          if (o.accessory !== undefined) s.acc = o.accessory || null;
          if (reset) {
            s.x = 30 + s.slot * 14; s.y = 42 + (s.slot % 2) * 3; s.dir = -1; s.emote = null; later.length = 0; s.then = null; s.sleepReason = null; s.inWheel = false;
            start('idle', 24); if (R.offHours && s.stage > 0) sleepNow('off');
            // 부화하거나 한 단계 자라면 그 자리에서 반짝이며 신나 한다
            if (grew && s.stage > 0 && !R.offHours) {
              for (let i = 0; i < 6; i++) after(i * 3, () => puff('spark', s.x + rnd(-9, 7), s.y - rnd(6, 18), { life: 14, vy: -0.25 }));
              reactTo('excited');
            }
          }
        },
        /* 먹이통이 찼을 때: 깨어 있으면 놀라서 먹으러 가고, 자는 펫은 깨면 간다 */
        fed() { if (!awake()) return; later.length = 0; leaveWheel(); reactTo('surprise'); s.then = 'eat'; },
        /* 학생이 공을 던져 줬을 때: 자거나 졸리거나 공에 질렸으면 놀지 않는다 */
        ballThrown(now) {
          if (!awake()) return 'asleep';
          later.length = 0; leaveWheel(); s.then = null;
          if (now < s.boredUntil) { reactTo('meh'); return 'bored'; }
          if (tired()) { reactTo('sleepy'); return 'tired'; }
          s.plays = s.plays.filter((at) => now - at < BALL_WINDOW_MS); s.plays.push(now);
          if (s.plays.length >= BALL_PLAYS) { s.boredUntil = now + BALL_REST_MS; s.plays = []; }
          reactTo('surprise'); s.then = 'play';
          return 'played';
        },
        /* 손이 와서 머리를 토닥이고, 끝나면 반응한다(좋아서 펄쩍 · 너무 자주면 당황 · 더 자주면 화남) */
        patted(now) {
          if (!awake()) return 'asleep';
          later.length = 0; leaveWheel(); s.then = null; s.emote = null;
          s.pats = s.pats.filter((at) => now - at < PAT_WINDOW_MS); s.pats.push(now);
          start('petted', 24);
          return 'petted';
        },
        warmed() { if (s.stage !== 0) return; s.t = 0; s.dur = 60; for (let i = 0; i < 2; i++) puff('spark', EGG.x + rnd(-6, 4), EGG.y - rnd(8, 14), { life: 10 }); puff('heart', EGG.x - 1, EGG.y - 16, { life: 18 }); },
        offHours(on) {
          if (s.stage === 0) return;
          later.length = 0; s.then = null; s.emote = null;
          if (on) sleepNow('off');
          else if (s.sleepReason === 'off') { s.sleepReason = null; start('yawn', 30); s.then = 'wake'; }
        },
        restore(o) {
          const n = s.needs, clamp = (v) => Math.max(0, Math.min(100, v));
          if (typeof o.hunger === 'number') n.hunger = clamp(o.hunger);
          if (typeof o.energy === 'number') n.energy = clamp(o.energy);
          if (typeof o.fun === 'number') n.fun = clamp(o.fun);
          if (Array.isArray(o.plays)) s.plays = o.plays.filter((at) => typeof at === 'number');
          if (typeof o.boredUntil === 'number') s.boredUntil = o.boredUntil;
          if (o.asleep && s.stage > 0 && !R.offHours) sleepNow('tired');
        },
        snapshot() {
          return { energy: Math.round(s.needs.energy), fun: Math.round(s.needs.fun), asleep: s.action === 'sleep' && s.sleepReason !== 'off', plays: s.plays, boredUntil: s.boredUntil };
        },
        sleepLeft() { return s.sleepReason === 'off' ? null : Math.max((100 - s.needs.energy) / (0.22 * R.rate), (240 - s.t * R.rate) / R.rate, 0); },
      };
    }

    /* ---------- 한 프레임 진행 ---------- */
    function tick() {
      R.clock += 1;
      R.fx = R.fx.filter((p) => { p.x += p.vx; p.y += p.vy; p.life -= 1; return p.life > 0; });
      ballStep();
      for (const p of pets) p.tick();
    }

    function stampTo(buf, rows, key, ox, oy, color) {
      rows.forEach((row, y) => [...row].forEach((ch, x) => {
        const gx = Math.round(ox) + x, gy = Math.round(oy) + y;
        if (ch === '.' || gx < 0 || gy < 0 || gx >= W || gy >= H) return;
        const v = color || key[ch]; if (v) buf[gy][gx] = v;
      }));
    }

    /* 쳇바퀴: 뒤 받침대 → 바퀴(테·발판·바큇살이 돌아간다) */
    function drawWheel(buf) {
      const { x: cx, y: cy, r } = WHEEL;
      const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) buf[y][x] = c; };
      const foot = cy + r + 2;
      for (let k = 0; k <= 10; k++) { const t = k / 10; set(Math.round(cx - 1 - 5 * t), Math.round(cy + (foot - cy) * t), '#8f8f9c'); set(Math.round(cx + 1 + 5 * t), Math.round(cy + (foot - cy) * t), '#8f8f9c'); }
      for (let x = cx - 8; x <= cx - 4; x++) set(x, foot, '#6b6b78');
      for (let x = cx + 4; x <= cx + 8; x++) set(x, foot, '#6b6b78');
      for (let y = cy - r - 1; y <= cy + r + 1; y++) for (let x = cx - r - 1; x <= cx + r + 1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const a = Math.atan2(y - cy, x - cx) + R.spin;
        if (d >= r - 0.5 && d < r + 0.5) set(x, y, y > cy + 2 ? '#2f6f9e' : '#4a9bd0');
        else if (d >= r - 1.5 && d < r - 0.5) set(x, y, Math.floor((a / (Math.PI / 8)) + 64) % 2 ? '#d8eefa' : '#8cc6e8');
        else if (d < r - 1.5) {
          const sp = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
          if (Math.min(sp, Math.PI / 2 - sp) * d < 0.55 && d > 0.6) set(x, y, '#a9d6f2');
        }
      }
      set(cx, cy, '#2f6f9e');
    }

    /* ---------- 한 프레임 그리기 → 80×48 색 ----------
       opt: decor(꾸미기 미리 보기), accessories({펫 id: 장식 id|null} 장식 미리 보기), noPet(물건만, 상점 그림용) */
    function render(opt = {}) {
      const decor = { ...R.decor, ...(opt.decor || {}) };
      const buf = bgOf(decor).map((row) => row.slice());
      const items = [];
      const bedKey = BED_KEYS[decor.bed] || BED_KEYS.basic;
      items.push({ k: BED.y - 8, draw: () => stampTo(buf, BED_ROWS.slice(0, 6), bedKey, BED.x - BED.w / 2, BED.y - 8) });
      items.push({ k: BED.y + 0.9, draw: () => stampTo(buf, BED_ROWS.slice(6), bedKey, BED.x - BED.w / 2, BED.y - 2) });
      const toy = TOYS[decor.toy];
      if (toy) items.push({ k: TOY.y, draw: () => stampTo(buf, toy.rows, toy.key, TOY.x - 3, TOY.y + 1 - toy.rows.length) });
      if (opt.noPet) {
        items.sort((a, b) => a.k - b.k).forEach((it) => it.draw());
        return buf;
      }
      // 먹이통: 방에 있는 펫 수만큼 채우니, 남은 몫을 6칸으로 보인다
      const full = 3 * Math.max(1, hatched().length);
      const kib = R.food > 0 ? Math.max(1, Math.ceil((R.food / full) * 6)) : 0;
      const bowl = ['.' + 'k'.repeat(Math.min(6, kib)).padEnd(6, '.') + '.', 'oyyyyyyo', 'oYYYYYYo', '.oooooo.'];
      items.push({ k: BOWL.y, draw: () => stampTo(buf, bowl, BOWL_KEY, BOWL.x - 4, BOWL.y - 3) });
      const ripple = pets.some((p) => p.s.action === 'drink' && p.s.t % 6 < 3);
      const water = [ripple ? '.bBbbBb.' : '.bbBbbb.', 'oggggggo', 'oGGGGGGo', '.oooooo.'];
      items.push({ k: WATER.y, draw: () => stampTo(buf, water, WATER_KEY, WATER.x - 4, WATER.y - 3) });
      if (hasWheel()) items.push({ k: WHEEL.y + WHEEL.r + 0.5, draw: () => drawWheel(buf) });
      const b = R.ball;
      items.push({ k: b.y, draw: () => {
        for (let x = -1; x <= 2; x++) { const gx = Math.round(b.x) + x - 1, gy = Math.round(b.y) + 1; if (gx >= 0 && gx < W && gy < H) buf[gy][gx] = mixc(buf[gy][gx], '#000000', 0.15); }
        stampTo(buf, BALL, BALL_KEY, b.x - 2, b.y - 3 - b.z);
      } });
      const overlays = [];
      for (const pet of pets) {
        const s = pet.s;
        const accPreview = opt.accessories && Object.hasOwn(opt.accessories, s.id) ? opt.accessories[s.id] : undefined;
        const pf = pet.frame(accPreview);
        const flip = s.dir > 0 && !pf.noFlip;
        const egg = s.stage === 0;
        const px = egg ? EGG.x : Math.round(s.x), py = egg ? EGG.y : Math.round(s.y);
        s.head = { x: px, top: py - 14 };
        const k = s.inWheel ? WHEEL.y + WHEEL.r + 0.6 : py + 0.5 + s.slot * 0.01;
        items.push({ k, draw: () => {
          const grid = pf.grid; const ox = px - 12 + (pf.dx || 0), oy = py - 22 + (pf.dy || 0);
          let x0 = 99, x1 = -1, top = 99;
          for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) if (grid[y][x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); top = Math.min(top, y); }
          if (x1 < 0) return;
          const fx0 = flip ? 23 - x1 : x0, fx1 = flip ? 23 - x0 : x1;
          // 바닥 그림자(뛰면 작아짐)
          const air = Math.max(0, -(pf.dy || 0)); const sw = Math.max(2, Math.round((fx1 - fx0) / 2) - 1 - air);
          const cx = px - 12 + Math.round((fx0 + fx1) / 2);
          if (!pf.inBed && !pf.noShadow) for (let x = -sw; x <= sw; x++) { const gx = cx + x, gy = py + 1; if (gx >= 0 && gx < W && gy < H) buf[gy][gx] = mixc(buf[gy][gx], '#000000', 0.16); }
          for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
            const v = grid[y][flip ? 23 - x : x]; if (!v) continue;
            const gx = ox + x, gy = oy + y; if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
            buf[gy][gx] = v;
          }
          // 머리 위치: 맨 위 세 줄의 가운데
          let sum = 0, cnt = 0;
          for (let y = top; y < Math.min(24, top + 3); y++) for (let x = 0; x < 24; x++) if (grid[y][flip ? 23 - x : x]) { sum += x; cnt += 1; }
          s.head = { x: ox + Math.round(sum / Math.max(1, cnt)), top: oy + top };
          s.box = { x0: ox + fx0, x1: ox + fx1, y0: oy + top, y1: py + 1 };
        } });
        overlays.push({ pet, hand: pf.hand });
      }
      items.sort((a, b2) => a.k - b2.k).forEach((it) => it.draw());
      for (const p of R.fx) { const g = GLYPH[p.glyph]; stampTo(buf, g.rows, g.key, p.x, p.y, p.color); }
      for (const { pet, hand } of overlays) {
        const s = pet.s, head = s.head; if (!head) continue;
        if (hand) {
          // 손: 머리 위에서 좌우로 쓰다듬으며 토닥인다
          const sway = [0, 1, 2, 1, 0, -1, -2, -1][Math.floor(s.t / 2) % 8];
          stampTo(buf, HAND, HAND_KEY, head.x - 5 + sway, head.top - 7 + (s.t % 8 < 4 ? 1 : 0));
        } else if (s.emote && ICONS[s.emote]) {
          const bx = Math.max(0, Math.min(W - 9, head.x - 3)), by = Math.max(0, head.top - 10);
          stampTo(buf, BUBBLE, { o: '#5d4037', W: '#ffffff' }, bx, by);
          stampTo(buf, ICONS[s.emote], ICON_KEY, bx + 2, by + 1);
        }
      }
      return buf;
    }

    /* ---------- 방에 있는 펫 맞추기(id로) ---------- */
    function setPets(list) {
      const keep = new Set(list.map((spec) => spec.id));
      for (let i = pets.length - 1; i >= 0; i--) if (!keep.has(pets[i].s.id)) pets.splice(i, 1);
      list.slice(0, 3).forEach((spec) => {
        const found = pets.find((p) => p.s.id === spec.id);
        if (found) { found.set(spec); return; }
        const used = new Set(pets.map((p) => p.s.slot));
        const slot = [0, 1, 2].find((n) => !used.has(n)) ?? pets.length;
        const pet = makePet(spec, slot);
        pets.push(pet);
        if (R.offHours && pet.s.stage > 0) pet.sleepNow('off');
      });
    }
    setPets(init.pets || []);
    const byId = (id) => pets.find((p) => p.s.id === id);

    const actions = {
      /* 먹이: 방에 있는 펫 모두 먹을 만큼 먹이통을 채운다. 자는 동안에도 채울 수 있고, 깨면 먹으러 간다 */
      feed() { R.food = 3 * Math.max(1, hatched().length); for (const p of hatched()) p.fed(); },
      /* 알 품어 주기: 알이 흔들리며 반짝인다 */
      warm() { for (const p of pets) p.warmed(); },
      /* 놀아 주기: 공을 던져 주면 모든 펫이 저마다 반응한다 */
      play() {
        throwBall();
        const out = { played: 0, tired: 0, bored: 0, asleep: 0 }; const now = Date.now();
        for (const p of hatched()) out[p.ballThrown(now)] += 1;
        return out;
      },
      /* 쓰다듬기: 깨어 있는 펫마다 손이 와서 머리를 토닥인다 */
      pat() {
        const out = { petted: 0, asleep: 0 }; const now = Date.now();
        for (const p of hatched()) out[p.patted(now)] += 1;
        return out;
      },
      setPets,
      /* 이용 시간 밖: 그동안은 모두 침대에서 자고 있고, 이용 시간이 되면 하품하며 깬다 */
      setOffHours(on) { R.offHours = on; R.fx = []; for (const p of pets) p.offHours(on); },
      setDecor(d) { R.decor = { ...R.decor, ...d }; },
      /* 앱에서 화면을 다시 열었을 때 이어 가기: 배고픔·기운·재미·공놀이 기록을 되살리고, 자던 펫은 침대에서 자고 있게 */
      restore(id, o) { const p = byId(id); if (p) p.restore(o); },
      snapshot(id) { const p = byId(id); return p ? p.snapshot() : null; },
      /* 펫마다 지금 기분 한 낱말 */
      moods() { return pets.map((p) => ({ id: p.s.id, mood: p.mood() })); },
      /* 깨어 있는 펫이 하나도 없으면 왜 자는지와 모두 일어날 때까지 남은 프레임(이용 시간 밖이면 이용 시간이 시작될 때 깬다) */
      sleepInfo() {
        const list = hatched(); if (!list.length) return null;
        if (R.offHours) return { reason: 'off', framesLeft: null };
        if (list.some((p) => p.s.action !== 'sleep')) return null;
        return { reason: 'tired', framesLeft: Math.min(...list.map((p) => p.sleepLeft() ?? 0)) };
      },
      /* 깨어 있는 펫 수(쓰다듬기를 할 수 있는지) */
      awakeCount() { return R.offHours ? 0 : hatched().filter((p) => p.s.action !== 'sleep').length; },
      /* 공을 던져 주면 놀 수 있는 펫 수와, 못 노는 까닭별 수(졸림·공에 질림), 질린 펫이 다시 놀 때까지 남은 분 */
      readiness() {
        const now = Date.now(); const out = { awake: 0, ready: 0, tired: 0, bored: 0, boredMinutes: 0 };
        if (R.offHours) return out;
        for (const p of hatched()) {
          if (p.s.action === 'sleep') continue;
          out.awake += 1;
          if (now < p.s.boredUntil) { out.bored += 1; out.boredMinutes = Math.max(out.boredMinutes, Math.ceil((p.s.boredUntil - now) / 60_000)); }
          else if (p.s.needs.energy < 25) out.tired += 1;
          else out.ready += 1;
        }
        return out;
      },
    };

    return { state: R, pets, tick, render, actions, W, H };
  }

  return { W, H, create, ICONS, ICON_KEY, BUBBLE, EMOTES, GAITS, SPECIALS, SHAKES, DAILY, DAILY_NAMES, DECOR, DECOR_SLOTS, DEFAULT_DECOR, DECOR_CROP };
})();
export default ROOM;

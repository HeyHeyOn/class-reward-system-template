/* 펫 그림 엔진: 견본(펫 키우기 견본 아티팩트)에서 확정한 칸 그림과 움직임에, 앱에서 더한 펫 장식(acc)을 그린다. 타입은 petSprites.d.ts. */
/* 작은 펫 도트 v3 (칸 그림을 손으로 찍음). 머리는 정면, 몸은 옆으로 앉아 꼬리가 오른쪽. 그림판은 24×24칸.
   글자: o 윤곽 · f 털 · m 밝은 털(주둥이·가슴·발) · e 눈(세로 2칸, 감으면 가로 2칸) · n 코 · i 귀 안 분홍(강아지는 늘어진 귀 색)
         t 자는 자세에서 몸 앞으로 감은 꼬리(털보다 조금 진하게)
         b 눈썹(검정 강아지만 보임) · 1 첫째 무늬(줄무늬·점) · 2 둘째 무늬(삼색의 검정) — 무늬 없는 색에서는 그냥 털
   볼(c)은 코 줄에서 주둥이 바로 바깥 털 칸: 기쁠 때만 분홍이 된다. */
const PETS = (() => {
  const W = 24, H = 24, BASE = 22; // BASE: 발바닥 아래 윤곽 줄

  /* 앉은 자세 */
  const SPRITES = {
    cat: {
      1: [
        '.o....o.....',
        'oio..oio....',
        'offoo22o....',
        'off1122o..o.',
        'ofeffefo.ofo',
        'ofeffefo.o1o',
        'ofmnnmfo.ofo',
        '.ofmmfoooofo',
        '..ommfof21fo',
        '..ommfoffffo',
        '..omomofmmo.',
        '..ooooooooo.',
      ],
      2: [
        '.o....o.......',
        'oio..oio......',
        'offoo22o...o..',
        'off1122o..ofo.',
        'ofeffefo..o1o.',
        'ofeffefo..ofo.',
        'ofmnnmfo..o1o.',
        '.ofmmfooooofo.',
        '..ommff122fffo',
        '..ommfoff1fffo',
        '..ommfoffff1o.',
        '..omomoffmmo..',
        '..oooooooooo..',
      ],
      3: [
        '.o....o.........',
        'oio..oio........',
        'offoo22o........',
        'off1122o.....o..',
        'ofeffefo....ofo.',
        'ofeffefo....o1o.',
        'ofmnnmfo....ofo.',
        '.ofmmfooooo.o1o.',
        '..ommffff122ofo.',
        '..ommfoff122ofo.',
        '..ommfoffff1ffo.',
        '..ommfofff1fffo.',
        '..ommfoffffffo..',
        '..omomofffmmmo..',
        '..oooooooooooo..',
      ],
    },
    dog: {
      1: [
        '..oooooo.....',
        '.offffffo....',
        'oifbffbfio...',
        'oifeffefio.o.',
        'oifeffefioofo',
        'oifmnnmfioofo',
        '.oimmmmiooofo',
        '..ommmmofffo.',
        '..ommfoff1fo.',
        '..omomofmmo..',
        '..ooooooooo..',
      ],
      2: [
        '..ooooooo.....',
        '.offfffffo....',
        'oi1bffbffio...',
        'oi1effeffio.o.',
        'oifeffeffioofo',
        'oifmnnmffioofo',
        '.oimmmmffioofo',
        '..oommmmoooofo',
        '..ofmmmof11ffo',
        '..ommfoff1fffo',
        '..ommfoffffo..',
        '..omomoffmmo..',
        '..oooooooooo..',
      ],
      3: [
        '..ooooooo.......',
        '.offfffffo......',
        'oifffffffio.....',
        'oi1bffbffio.....',
        'oi1effeffio..oo.',
        'oifeffeffio.ofo.',
        'oifmnnmffio.ofo.',
        '.oimmmmffio.ofo.',
        '..oommmmooooofo.',
        '..ofmmmof11fffo.',
        '..ommmmoff11ffo.',
        '..ommfoffffffo..',
        '..ommfofffffffo.',
        '..ommfoffffffo..',
        '..omomofffmmmo..',
        '..oooooooooooo..',
      ],
    },
    rabbit: {
      1: [
        '.oo..oo.....',
        'ofiooifo....',
        'ofiooifo....',
        'offffffo....',
        'ofeffefo....',
        'ofeffefooo..',
        'ofmnnmfo11o.',
        '.ofmmfoff1mo',
        '..ommfoffmmo',
        '..omomofmmo.',
        '..ooooooooo.',
      ],
      2: [
        '.oo..oo.......',
        'o1iooi1o......',
        'o1iooi1o......',
        'ofiooifo......',
        'offffffo......',
        'ofeffefo......',
        'ofeffefoooo...',
        'ofmnnmfof11o..',
        '.ofmmfoff111o.',
        '..ommfoffff1mo',
        '..ommfofffffmo',
        '..omomoffmmoo.',
        '..oooooooooo..',
      ],
      3: [
        '.oo..oo.........',
        'o1iooi1o........',
        'o1iooi1o........',
        'ofiooifo........',
        'ofiooifo........',
        'offffffo........',
        'ofeffefo........',
        'ofeffefoooo.....',
        'ofmnnmfof11oo...',
        '.ofmmfoff1111o..',
        '..ommfofff1111o.',
        '..ommfofffff11mo',
        '..ommfoffffffmmo',
        '..omomofffmmooo.',
        '..ooooooooooo...',
      ],
    },
    hamster: {
      1: [
        '..oo..oo...',
        '.oiooiooo..',
        'of1112ffo..',
        'ofeffef11o.',
        'ofeffeff2fo',
        'omnnmmfff2o',
        '.ommmmfffo.',
        '..omomomo..',
        '...ooooo...',
      ],
      2: [
        '..oo...oo...',
        '.oiooooioo..',
        'of11112111o.',
        'ofeffeff221o',
        'ofeffefff22o',
        'ommnnmmfff2o',
        '.ommmmmfffo.',
        '..omomofmo..',
        '...oooooo...',
      ],
      3: [
        '..oo...oo....',
        '.oiooooiooo..',
        'of111121111o.',
        'ofeffefff221o',
        'ofeffefff221o',
        'ommnnmmfff22o',
        '.ommmmmfffffo',
        '.ommmmmffffo.',
        '..omomofmmo..',
        '...ooooooo...',
      ],
    },
    canary: {
      1: [
        '..oooo.....',
        '.offffo....',
        'offffffo...',
        'ofeffefo...',
        'ofeffefooo.',
        'offaaffo1oo',
        '.offffo11fo',
        '..ommffff1o',
        '...ommfffoo',
        '....oaoao..',
        '..oowwwwwo.',
        '..ooooooooo',
      ],
      2: [
        '..oooo.........',
        '.offffo........',
        'offffffo.......',
        'ofeffefo.......',
        'ofeffefooo.....',
        'offaaffo11o....',
        '.offffo1111o...',
        '..omfff1111fo..',
        '..ommfffff1ffo.',
        '...ommmffooo1o.',
        '....oaoaoo..oo.',
        '..oowwwwwwoo...',
        '..oooooooooo...',
      ],
      3: [
        '..oooo..........',
        '.offffo.........',
        'offffffo........',
        'ofeffefo........',
        'ofeffefooo......',
        'offaaffo11oo....',
        '.offffo1111fo...',
        '..offf11111ffo..',
        '..omffff1111ffo.',
        '..ommffffffoo1fo',
        '...ommmfffo..o1o',
        '....oaoaoo....oo',
        '..oowwwwwwooo...',
        '..oooooooooo....',
      ],
    },
    turtle: {
      1: [
        '..oooo.....',
        '.offffooo..',
        'offffffsdo.',
        'ofeffefosdo',
        'orefferodso',
        'offmmffosso',
        '.offffoooo.',
        '..ofo.ofo..',
        '..ooo.ooo..',
      ],
      2: [
        '..oooo........',
        '.offffo.......',
        'offffffoooo...',
        'ofeffefosddso.',
        'orefferodssdso',
        'offmmffossddso',
        '.offffoossdso.',
        '..offoooooooo.',
        '..ofo.ofo.ofo.',
        '..ooo.ooo.ooo.',
      ],
      3: [
        '..oooo..........',
        '.offffo.........',
        'offffffooooo....',
        'ofeffefosddsoo..',
        'orefferosdssdso.',
        'offmmffosssddsso',
        '.offffoossddsso.',
        '..offoooooooooo.',
        '..ofo.ofo.ofo.of',
        '..ooo.ooo.ooo.oo',
      ],
    },
    lizard: {
      1: [
        '.oooooo.......',
        'offffffo......',
        'ofeffefooooo..',
        'ofeffefof1ffo.',
        'offffffoff1ffo',
        '.ommmmooffoooo',
        '..oooo.ofo....',
        '.......ooo....',
      ],
      2: [
        '.oooooo..........',
        'offffffo.........',
        'ofeffefoooooo....',
        'ofeffefof1ff1ooo.',
        'offffffoff1f1ff1o',
        '.ommmmooffffoooo.',
        '..oooo.ofoofo....',
        '.......ooooo.....',
      ],
      3: [
        '.oooooo.............',
        'offffffo............',
        'ofeffefooooooo......',
        'ofeffefof1ff1fooooo.',
        'offffffof1ff1ff1fffo',
        '.ommmmoofffffffoooo.',
        '..oooo.ofoooofo.....',
        '.......ooo..ooo.....',
      ],
    },
  };
  /* 엎드려 자는 자세: 머리는 앞발 위, 몸은 옆으로 길게, 꼬리(t)는 몸 앞으로 감김 */
  const SLEEP = {
    cat: {
      1: [
        '.o....o........',
        'oio..oio.......',
        'offoo22o.......',
        'off1122ooooo...',
        'ofeffefof1f2o..',
        'ofeffefoff1ffo.',
        'ofmnnmfofffffo.',
        '.ofmmfoffttffo.',
        'ommommotttttto.',
        'oooooooooooooo.',
      ],
      2: [
        '.o....o..........',
        'oio..oio.........',
        'offoo22o.........',
        'off1122oooooooo..',
        'ofeffefof1ff22o..',
        'ofeffefoff1f222o.',
        'ofmnnmfofff1ffffo',
        '.ofmmfofffff1fffo',
        'ommommofftttttffo',
        'ooooooootttttttoo',
        '........ooooooo..',
      ],
      3: [
        '.o....o............',
        'oio..oio...........',
        'offoo22o...........',
        'off1122ooooooooo...',
        'ofeffefof1ff1f22o..',
        'ofeffefoff1ff1f22o.',
        'ofmnnmfoffff1ff1ffo',
        '.ofmmfoffffff1ffffo',
        'ommommoffffffffffo.',
        'oooooooftttttttfo..',
        '.......oottttttoo..',
        '.........oooooo....',
      ],
    },
    dog: {
      1: [
        '..oooooo.......',
        '.offffffo......',
        'oifbffbfiooooo.',
        'oifeffefiof1ffo',
        'oifeffefioffffo',
        'oifmnnmfioffffo',
        '.oimmmmiofffffo',
        'ommooommffffffo',
        'oooooooooooooo.',
      ],
      2: [
        '..ooooooo.........',
        '.offfffffo........',
        'oi1bffbffioooooo..',
        'oi1effeffiof11ffo.',
        'oifeffeffioff1fffo',
        'oifmnnmffioffffffo',
        '.oimmmmffioffffffo',
        'ommoooommoffffffo.',
        'oooooooooooooooo..',
      ],
      3: [
        '..ooooooo...........',
        '.offfffffo..........',
        'oifffffffio.........',
        'oi1bffbffiooooooooo.',
        'oi1effeffiof11fffffo',
        'oifeffeffioff11ffffo',
        'oifmnnmffioffffffffo',
        '.oimmmmffioffffffffo',
        'ommooooommfffffffffo',
        'ooooooooooooooooooo.',
      ],
    },
    rabbit: {
      1: [
        '..ooooooo...',
        '.offoiiio...',
        'offfoooooo..',
        'ofeffefo1o..',
        'ofeffefof1o.',
        'ofmnnmfoffmo',
        '.ofmmfofffmo',
        'ommommooooo.',
        'oooooooo....',
      ],
      2: [
        '..oooooooooo...',
        '.offoiiiiiio...',
        'offfoooooooooo.',
        'ofeffefof111o..',
        'ofeffefoff11fo.',
        'ofmnnmfofffffmo',
        '.ofmmfoffffffmo',
        'ommommoooooooo.',
        'oooooooo.......',
      ],
      3: [
        '..oooooooooooo....',
        '.offoiiiiiiiio....',
        'offfoooooooooooo..',
        'ofeffefoff1111fo..',
        'ofeffefofff1111fo.',
        'ofmnnmfoffffff11mo',
        '.ofmmfofffffffffmo',
        'ommommoffffffffoo.',
        'ooooooooooooooo...',
      ],
    },
    hamster: {
      1: [
        '..oo..oo...',
        '.oiooiooo..',
        'of11f21ffo.',
        'ofeffeff21o',
        'omnnmmfff2o',
        '.ooooooooo.',
      ],
      2: [
        '..oo...oo....',
        '.oiooooiooo..',
        'of11ff2111fo.',
        'ofeffefff21fo',
        'ommnnmmfff22o',
        '.ommmmmffffo.',
        '..ooooooooo..',
      ],
      3: [
        '..oo...oo......',
        '.oiooooioooo...',
        'of11ff211111o..',
        'ofeffeffff221o.',
        'ommnnmmffff22fo',
        '.ommmmmffffff2o',
        '..ooooooooooooo',
      ],
    },
    turtle: {
      1: [
        '..oooo.ooo..',
        '.offffoosdo.',
        'offffffodso.',
        'ofeffefosdso',
        'orefferodsdo',
        'offmmffooooo',
        '.oooooo.....',
      ],
      2: [
        '..oooo..oooo...',
        '.offffoosddsoo.',
        'offffffodssddso',
        'ofeffefossddsso',
        'orefferossdsdso',
        'offmmffoooooooo',
        '.oooooo........',
      ],
      3: [
        '.........ooooo...',
        '..oooo..osddsoo..',
        '.offffoosdssdsso.',
        'offffffosssddssso',
        'ofeffefossddssdso',
        'orefferossddssdso',
        'offmmffooooooooo.',
        '.oooooo..........',
      ],
    },
    lizard: {
      1: [
        '.oooooo.......',
        'offffffo......',
        'ofeffefooooo..',
        'ofeffefof1ffo.',
        'offffffoff1ffo',
        '.ommmmooffoooo',
        '..oooooooo....',
      ],
      2: [
        '.oooooo..........',
        'offffffo.........',
        'ofeffefoooooo....',
        'ofeffefof1ff1ooo.',
        'offffffoff1f1ff1o',
        '.ommmmooffffoooo.',
        '..oooooooooo.....',
      ],
      3: [
        '.oooooo.............',
        'offffffo............',
        'ofeffefooooooo......',
        'ofeffefof1ff1fooooo.',
        'offffffof1ff1ff1fffo',
        '.ommmmoofffffffoooo.',
        '..ooooooooooooo.....',
      ],
    },
    canary: {
      1: [
        '..oooo.....',
        '.offffo....',
        'offffffo...',
        'ofeffefo...',
        'ofeffefooo.',
        'offaaffo1oo',
        '.offffo11fo',
        '..ommffff1o',
        '...ommfffoo',
        '....oaoao..',
        '..oowwwwwo.',
        '..ooooooooo',
      ],
      2: [
        '..oooo.........',
        '.offffo........',
        'offffffo.......',
        'ofeffefo.......',
        'ofeffefooo.....',
        'offaaffo11o....',
        '.offffo1111o...',
        '..omfff1111fo..',
        '..ommfffff1ffo.',
        '...ommmffooo1o.',
        '....oaoaoo..oo.',
        '..oowwwwwwoo...',
        '..oooooooooo...',
      ],
      3: [
        '..oooo..........',
        '.offffo.........',
        'offffffo........',
        'ofeffefo........',
        'ofeffefooo......',
        'offaaffo11oo....',
        '.offffo1111fo...',
        '..offf11111ffo..',
        '..omffff1111ffo.',
        '..ommffffffoo1fo',
        '...ommmfffo..o1o',
        '....oaoaoo....oo',
        '..oowwwwwwooo...',
        '..oooooooooo....',
      ],
    },
  };
  /* 선 자세(걸을 때, 강아지·고양이만): 머리·꼬리 줄은 앉은 자세와 같고, 몸은 가로로 눕혀 다리 넷이 보인다(앞발 둘, 뒷발 둘) */
  const WALK = {
    dog: {
      1: [
        '..oooooo.....',
        '.offffffo....',
        'oifbffbfio...',
        'oifeffefio.o.',
        'oifeffefioofo',
        'oifmnnmfioofo',
        '.oimmmmiooofo',
        '..ommmmff1ffo',
        '..omomooofofo',
        '..omomo.omomo',
        '..ooooo.ooooo',
      ],
      2: [
        '..ooooooo.....',
        '.offfffffo....',
        'oi1bffbffio...',
        'oi1effeffio.o.',
        'oifeffeffioofo',
        'oifmnnmffioofo',
        '.oimmmmffioofo',
        '..oommmmoooofo',
        '..ofmmmff11ffo',
        '..ommmfff1fffo',
        '..omomoooofofo',
        '..omomo..omomo',
        '..ooooo..ooooo',
      ],
      3: [
        '..ooooooo.......',
        '.offfffffo......',
        'oifffffffio.....',
        'oi1bffbffio.....',
        'oi1effeffio..oo.',
        'oifeffeffio.ofo.',
        'oifmnnmffio.ofo.',
        '.oimmmmffio.ofo.',
        '..oommmmooooofo.',
        '..ofmmmff11fffo.',
        '..ommmmff11fffo.',
        '..ommmffffffffo.',
        '..omomooooofofo.',
        '..omomo...omomo.',
        '..ooooo...ooooo.',
      ],
    },
    cat: {
      1: [
        '.o....o.....',
        'oio..oio....',
        'offoo22o....',
        'off1122o..o.',
        'ofeffefo.ofo',
        'ofeffefo.o1o',
        'ofmnnmfo.ofo',
        '.ofmmfoooofo',
        '..ommff21ffo',
        '..omomoofofo',
        '..omomoomomo',
        '..oooooooooo',
      ],
      2: [
        '.o....o.......',
        'oio..oio......',
        'offoo22o...o..',
        'off1122o..ofo.',
        'ofeffefo..o1o.',
        'ofeffefo..ofo.',
        'ofmnnmfo..o1o.',
        '.ofmmfooooofo.',
        '..ommff122fffo',
        '..ommffff1fffo',
        '..omomoooofofo',
        '..omomo..omomo',
        '..ooooo..ooooo',
      ],
      3: [
        '.o....o.........',
        'oio..oio........',
        'offoo22o........',
        'off1122o.....o..',
        'ofeffefo....ofo.',
        'ofeffefo....o1o.',
        'ofmnnmfo....ofo.',
        '.ofmmfooooo.o1o.',
        '..ommffff122ofo.',
        '..ommffff122ffo.',
        '..ommfffff1fffo.',
        '..omomooooofofo.',
        '..omomo...omomo.',
        '..ooooo...ooooo.',
      ],
    },
  };

  /* 알: 털 색은 부화할 때 정해지니 종마다 같은 무늬(강아지 발자국, 고양이 줄무늬) */
  const EGGS = {
    dog: ["..oooo..", ".ohfffo.", "ohffffso", "ohf1f1so", "of1fff1o", "off111so", "off111so", ".offsso.", "..oooo.."],
    cat: ["..oooo..", ".ohfffo.", "ohffffso", "o111111o", "offfffso", "o111111o", "offfffso", ".offsso.", "..oooo.."],
    rabbit: ["..oooo..", ".ohfffo.", "ohf1fffo", "offff1so", "of1fffso", "offf1fso", "o1fffsso", ".offsso.", "..oooo.."],
    hamster: ["..oooo..", ".ohfffo.", "ohff1fso", "of1ffffo", "offff1so", "off1ffso", "offfff1o", ".offsso.", "..oooo.."],
    canary: ["..ooo..", ".ohffo.", "ohf1fso", "off1fso", "o1fffso", "offf1so", ".offso.", "..ooo.."],
    turtle: ["..oooo..", ".ohhffo.", "ohhffffo", "ohfffsso", "offffsso", ".offsso.", "..oooo.."],
    lizard: ["..oooo..", ".ohfffo.", "ohff1fso", "offfffso", "of1fffso", "offff1so", "offfffso", ".offsso.", "..oooo.."],
  };
  const EGG_COLORS = {
    dog: {"o": "#5f7f9e", "f": "#e3f1fb", "h": "#ffffff", "s": "#c6dcee", "1": "#8fb3d6"},
    cat: {"o": "#9e6f80", "f": "#fde6ee", "h": "#ffffff", "s": "#f2c9d7", "1": "#f2a0bb"},
    rabbit: {"o": "#6f8f6a", "f": "#e6f4e3", "h": "#ffffff", "s": "#cfe6cb", "1": "#f6a76a"},
    hamster: {"o": "#9a7b3c", "f": "#fff3cf", "h": "#ffffff", "s": "#f3e2b0", "1": "#c99a4a"},
    canary: {"o": "#6c8ea6", "f": "#dff0fb", "h": "#ffffff", "s": "#c5ddee", "1": "#9b6b4a"},
    turtle: {"o": "#9a9384", "f": "#fbfaf5", "h": "#ffffff", "s": "#e8e4d8", "1": "#e8e4d8"},
    lizard: {"o": "#a0907a", "f": "#f7f1e6", "h": "#ffffff", "s": "#e9dfcc", "1": "#d6c4a2"},
  };
  /* 털 색: 글자마다 색. pink/blush는 볼, 눈썹 b는 검정 강아지만 다르다 */
  const COLORS = {
    cat: [
      { id: 'cheese', name: '치즈', o: '#5a2f12', f: '#f0a359', m: '#fbe6cc', e: '#2a1a12', n: '#e98a9f', i: '#f3a7bd', 1: '#c96d2a', 2: '#f0a359' },
      { id: 'mackerel', name: '고등어', o: '#2f3339', f: '#a3abb4', m: '#eef0f2', e: '#1c1f24', n: '#e98a9f', i: '#f3a7bd', 1: '#646c76', 2: '#a3abb4' },
      { id: 'black', name: '검정', o: '#121115', f: '#3b3841', m: '#3b3841', e: '#f5d33b', n: '#e98a9f', i: '#c9798f', 1: '#3b3841', 2: '#3b3841' },
      { id: 'calico', name: '삼색', o: '#4b443b', f: '#f6f3ec', m: '#ffffff', e: '#2a1a12', n: '#e98a9f', i: '#f3a7bd', 1: '#f0a359', 2: '#3d3a42' },
    ],
    dog: [
      { id: 'brown', name: '갈색', o: '#40220c', f: '#c98a52', m: '#f4dcbc', e: '#22150d', n: '#2a1a12', i: '#a96d3a', b: '#c98a52', 1: '#c98a52', 2: '#c98a52' },
      { id: 'cream', name: '크림', o: '#6e4519', f: '#efc68c', m: '#fff3df', e: '#22150d', n: '#2a1a12', i: '#d8a865', b: '#efc68c', 1: '#efc68c', 2: '#efc68c' },
      { id: 'black', name: '검정', o: '#111014', f: '#3e3c45', m: '#c98a52', e: '#151418', n: '#111014', i: '#2d2b32', b: '#c98a52', 1: '#3e3c45', 2: '#3e3c45' },
      { id: 'spot', name: '바둑이', o: '#4b443b', f: '#f6f3ec', m: '#ffffff', e: '#22150d', n: '#2a1a12', i: '#8d5a32', b: '#f6f3ec', 1: '#8d5a32', 2: '#8d5a32' },
    ],
    rabbit: [
      {"id": "white", "name": "흰색", "o": "#5b4a42", "f": "#f7f3ee", "m": "#ffffff", "e": "#2a1a12", "n": "#e98a9f", "i": "#f3a7bd", "1": "#f7f3ee", "2": "#f7f3ee"},
      {"id": "brown", "name": "갈색", "o": "#4a3020", "f": "#b98a62", "m": "#f1e1cc", "e": "#22150d", "n": "#e98a9f", "i": "#e9b9a4", "1": "#b98a62", "2": "#b98a62"},
      {"id": "gray", "name": "회색", "o": "#363a3f", "f": "#9ea3a8", "m": "#eceef0", "e": "#1c1f24", "n": "#e98a9f", "i": "#e8b7c2", "1": "#9ea3a8", "2": "#9ea3a8"},
      {"id": "dutch", "name": "얼룩", "o": "#4b443b", "f": "#f7f3ee", "m": "#ffffff", "e": "#2a1a12", "n": "#e98a9f", "i": "#f3a7bd", "1": "#4a4450", "2": "#4a4450"},
    ],
    hamster: [
      {"id": "golden", "name": "골든", "o": "#6b3d16", "f": "#e9a85c", "m": "#fff4e4", "e": "#2a1a12", "n": "#e98a9f", "i": "#f3a7bd", "1": "#c97f35", "2": "#e9a85c"},
      {"id": "jungle", "name": "정글리안", "o": "#3c3c46", "f": "#a9abb5", "m": "#f7f7f9", "e": "#1c1f24", "n": "#e98a9f", "i": "#e8b7c2", "1": "#5e606c", "2": "#a9abb5"},
      {"id": "cream", "name": "크림", "o": "#7a5a2c", "f": "#f3dfbf", "m": "#fffaf0", "e": "#2a1a12", "n": "#e98a9f", "i": "#f3a7bd", "1": "#e6c99a", "2": "#f3dfbf"},
      {"id": "panda", "name": "판다", "o": "#3a3640", "f": "#f7f4ef", "m": "#ffffff", "e": "#1c1f24", "n": "#e98a9f", "i": "#d9a3b4", "1": "#3d3a42", "2": "#3d3a42"},
    ],
    canary: [
      {"id": "yellow", "name": "노랑", "o": "#8a5a00", "f": "#ffd54f", "m": "#fff3b0", "e": "#2a1a12", "n": "#ff9f43", "a": "#ff9f43", "w": "#9c6b3c", "i": "#ffd54f", "1": "#f2b830", "2": "#ffd54f"},
      {"id": "orange", "name": "주황", "o": "#8a3d00", "f": "#ffab40", "m": "#ffe0b2", "e": "#2a1a12", "n": "#ff7043", "a": "#ff7043", "w": "#9c6b3c", "i": "#ffab40", "1": "#f08a1c", "2": "#ffab40"},
      {"id": "white", "name": "흰색", "o": "#7a756c", "f": "#fbfaf6", "m": "#ffffff", "e": "#2a1a12", "n": "#ffb74d", "a": "#ffb74d", "w": "#9c6b3c", "i": "#fbfaf6", "1": "#e3dfd6", "2": "#fbfaf6"},
      {"id": "green", "name": "초록", "o": "#3d4f1c", "f": "#b5cc6a", "m": "#eef3c8", "e": "#1c2410", "n": "#d9a55a", "a": "#d9a55a", "w": "#9c6b3c", "i": "#b5cc6a", "1": "#6f8a2c", "2": "#b5cc6a"},
    ],
    turtle: [
      {"id": "green", "name": "초록", "o": "#2f4a22", "f": "#9ccc65", "m": "#dcedc8", "e": "#1b2a14", "n": "#558b2f", "s": "#6d8f3b", "d": "#4f6b28", "r": "#9ccc65", "i": "#9ccc65", "1": "#9ccc65", "2": "#9ccc65"},
      {"id": "brown", "name": "갈색", "o": "#3e2a1c", "f": "#c2b280", "m": "#ece3c4", "e": "#22150d", "n": "#8d7a4a", "s": "#8d6e52", "d": "#5d4632", "r": "#c2b280", "i": "#c2b280", "1": "#c2b280", "2": "#c2b280"},
      {"id": "redear", "name": "붉은귀", "o": "#28401c", "f": "#8bbf4a", "m": "#e3f0b8", "e": "#1b2a14", "n": "#558b2f", "s": "#4f7a2e", "d": "#d6c24a", "r": "#e53935", "i": "#8bbf4a", "1": "#8bbf4a", "2": "#8bbf4a"},
      {"id": "star", "name": "별무늬", "o": "#2a2014", "f": "#d6b45a", "m": "#f4e6b8", "e": "#22150d", "n": "#a5843a", "s": "#3e2f1c", "d": "#f2c14e", "r": "#d6b45a", "i": "#d6b45a", "1": "#d6b45a", "2": "#d6b45a"},
    ],
    lizard: [
      {"id": "leopard", "name": "표범", "o": "#6b4a12", "f": "#ffd96a", "m": "#fff4cc", "e": "#2a1a12", "n": "#e98a9f", "i": "#ffd96a", "1": "#4a3a20", "2": "#ffd96a"},
      {"id": "tangerine", "name": "오렌지", "o": "#7a3200", "f": "#ffab40", "m": "#ffe8c4", "e": "#2a1a12", "n": "#e98a9f", "i": "#ffab40", "1": "#e65100", "2": "#ffab40"},
      {"id": "green", "name": "초록", "o": "#28440f", "f": "#8bc34a", "m": "#e3f2c8", "e": "#14200a", "n": "#e98a9f", "i": "#8bc34a", "1": "#33691e", "2": "#8bc34a"},
      {"id": "snow", "name": "흰색", "o": "#5e5a66", "f": "#f3efe6", "m": "#ffffff", "e": "#1c1f24", "n": "#e98a9f", "i": "#f3efe6", "1": "#8d8d99", "2": "#f3efe6"},
    ]
  };
  const FX = { h: '#ff6f91', H: '#c2185b', s: '#ffe066', S: '#fff8c4', w: '#ffffff', y: '#a8321f', Y: '#ef6c57', k: '#7a4a24', p: '#f7a1b5', z: '#7e8fb8', q: '#6a7bd6' };

  const STAGES = [{ id: 'egg', name: '알' }, { id: 'baby', name: '아기' }, { id: 'young', name: '어린' }, { id: 'adult', name: '다 자람' }];

  /* 볼 칸: 코가 있는 줄에서 주둥이(m) 바로 바깥 털 칸 */
  function cheeks(rows) {
    const y = rows.findIndex((r) => r.includes('n'));
    if (y < 0) return [];
    const r = rows[y]; const a = r.indexOf('m'), b = r.lastIndexOf('m');
    return [[a - 1, y], [b + 1, y]].filter(([x]) => r[x] === 'f');
  }

  const mix = (a, b, t) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');

  /* 감은 눈: 눈마다 아래 칸 + 옆 칸 하나(가로 2칸 '- -'), 위 칸은 털.
     옆 칸은 안쪽으로 그리되, 두 선 사이에 틈이 안 남으면(눈 사이가 2칸이면) 바깥쪽으로 */
  function closedEyes(rows) {
    const cells = []; rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === 'e') cells.push([x, y]); }));
    if (!cells.length) return { off: [], line: [] };
    const cols = [...new Set(cells.map(([x]) => x))].sort((a, b) => a - b); const mid = cols.reduce((a, b) => a + b, 0) / cols.length;
    const inward = cols.length < 2 || cols[cols.length - 1] - cols[0] - 3 >= 1;
    const off = [], line = [];
    for (const x of cols) {
      const ys = cells.filter(([cx]) => cx === x).map(([, y]) => y).sort((a, b) => a - b); const yb = ys[ys.length - 1];
      ys.slice(0, -1).forEach((y) => off.push([x, y]));
      const toward = (x < mid ? 1 : -1) * (inward ? 1 : -1);
      line.push([x, yb], [x + toward, yb]);
    }
    return { off, line };
  }

  /* 움직이는 부위(앉은 자세). 기본은 세로로 선 꼬리·귀: x0 오른쪽, rows 줄 중 위 두 줄(끝)만 옆으로.
     axis 'y'는 가로로 뻗은 꼬리(도마뱀): x1 오른쪽은 위로 wag칸, x0~x1 사이는 절반만 */
  const TAILS = {
    dog: { 1: { x0: 10, rows: [3, 6] }, 2: { x0: 11, rows: [3, 7] }, 3: { x0: 12, rows: [4, 8] } },
    cat: { 1: { x0: 9, rows: [3, 7] }, 2: { x0: 10, rows: [2, 7] }, 3: { x0: 12, rows: [3, 9] } },
    // 토끼 오른쪽 귀: lean이면 귀 전체가 뿌리(맨 아래 줄)를 축으로 기운다(끝은 wag칸, 아래로 갈수록 줄어듦)
    rabbit: { 1: { x0: 4, rows: [0, 2], lean: true }, 2: { x0: 4, rows: [0, 3], lean: true }, 3: { x0: 4, rows: [0, 4], lean: true } },
    lizard: { 1: { axis: 'y', x0: 11, x1: 12, rows: [3, 5] }, 2: { axis: 'y', x0: 12, x1: 14, rows: [3, 5] }, 3: { axis: 'y', x0: 15, x1: 17, rows: [3, 5] } },
  };
  /* 움직임(칸 수). 강아지: 평소엔 천천히 한 칸, 좋으면 두 칸까지 빠르게(오른쪽으로만 — 왼쪽은 귀와 겹친다).
     고양이: 평소엔 끝을 좌우로 느리게 살랑, 좋으면 세운 채 끝만 파르르 떨고, 먹이 먹을 땐 가만히.
     토끼: 평소엔 가끔 한쪽 귀를 쫑긋, 좋으면 귀를 연달아 까딱. 도마뱀: 꼬리 끝을 천천히 들었다 놓고, 좋으면 빠르게. */
  const NONE = { calm: () => 0, happy: () => 0, still: () => 0 };
  const TAIL_MOVES = {
    dog: { calm: (f) => (Math.floor(f / 6) % 2 ? 1 : 0), happy: (f) => [0, 1, 2, 1][Math.floor(f / 1.5) % 4], still: () => 0 },
    cat: { calm: (f) => [0, 1, 0, -1][Math.floor(f / 9) % 4], happy: (f) => (Math.floor(f / 1.5) % 2 ? 1 : 0), still: () => 0 },
    // 토끼: 평소엔 가끔 한쪽 귀 전체를 바깥으로 까딱(0→1→2→1→0), 좋으면 연달아 까딱
    rabbit: { calm: (f) => [0, 1, 2, 2, 1, 0][Math.max(0, Math.min(5, (f % 48) - 30))] ?? 0, happy: (f) => [0, 1, 2, 1][Math.floor(f / 1.5) % 4], still: () => 0 },
    lizard: { calm: (f) => [0, 0, 1, 1][Math.floor(f / 8) % 4], happy: (f) => [0, 1, 2, 1][Math.floor(f / 2) % 4], still: () => 0 },
    hamster: NONE, canary: NONE, turtle: NONE,
  };

  /* 걷는 발: 발 줄(맨 아래 윤곽 바로 위)에서 바로 아래가 윤곽인 발 칸(m·a, 없으면 f)을 이어진 것끼리 묶고,
     step 1이면 첫째·셋째 묶음을, 2면 둘째·넷째 묶음을 한 칸 든다(발 칸은 윤곽으로, 그 아래 윤곽 줄은 비움).
     앞발과 뒷발이 엇갈려 들려서 총총 걷는 것처럼 보인다 */
  function lifted(rows, step) {
    const h = rows.length; const paw = [...rows[h - 2]], bot = [...rows[h - 1]];
    const pick = (chars) => {
      const g = [];
      paw.forEach((ch, x) => { if (chars.includes(ch) && bot[x] === 'o') { const last = g[g.length - 1]; if (last && last[last.length - 1] === x - 1) last.push(x); else g.push([x]); } });
      return g;
    };
    let groups = pick('ma'); if (!groups.length) groups = pick('f');
    groups.forEach((g, i) => {
      if (i % 2 !== step - 1) return;
      for (const x of g) { paw[x] = 'o'; bot[x] = '.'; }
      const a = g[0] - 1, b = g[g.length - 1] + 1;
      if (paw[a] === 'o') bot[a] = '.';
      if (paw[b] === 'o') bot[b] = '.';
    });
    return [...rows.slice(0, h - 2), paw.join(''), bot.join('')];
  }

  /* ---------- 펫 장식 ----------
     모든 종에 맞도록 그림(rows)에서 자리를 찾는다: 눈(e)으로 얼굴 가운데와 머리 위를, 코(n)·부리(a)·입(mm)
     아래에서 목 줄을 찾는다. 머리 장식은 오른쪽 눈 위(귀 언저리)나 머리 꼭대기, 목 장식은 목 줄의 털 칸에 그린다.
     방에서 오른쪽을 보면 그림 전체를 뒤집으니 장식도 함께 뒤집힌다. 엎드려 자는 자세에서는 목이 앞발에 가려 목 장식을 그리지 않는다. */
  const ACC = {
    ribbon: { at: 'side', rows: ['r...r', 'rrKrr', 'r...r'], key: { r: '#e8364f', K: '#a3162b' } },
    flower: { at: 'side', rows: ['.p.', 'pyp', '.p.'], key: { p: '#ff8fb8', y: '#ffd23f' } },
    crown: { at: 'top', rows: ['y.Y.y', 'yyRyy'], key: { y: '#f5c02e', Y: '#ffe27a', R: '#e53950' } },
    pearl: { at: 'neck', band: ['#ffffff', '#8f77b5'] },
    bell: { at: 'neck', band: ['#e53935'], drop: ['#ffc83d', '#b8860b'] },
    bowtie: { at: 'neck', rows: ['b...b', 'bbKbb', 'b...b'], key: { b: '#3d6fd8', K: '#1f3f8f' } },
    scarf: { at: 'neck', band: ['#e0463c', '#fff4e6'], thick: true },
  };

  /* 그림 rows에서 장식 자리: 얼굴 가운데 x, 눈 맨 윗줄, 오른쪽 눈, 목 줄과 그 줄의 털 칸 범위 */
  function anchors(rows) {
    const eyes = [];
    rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === 'e' && x < 10) eyes.push([x, y]); }));
    if (!eyes.length) return null;
    const cols = [...new Set(eyes.map(([x]) => x))].sort((a, b) => a - b);
    const left = cols[0], right = cols[cols.length - 1], top = Math.min(...eyes.map(([, y]) => y));
    const cx = (left + right) / 2;
    const topAt = (x) => { for (let y = 0; y < rows.length; y++) if (rows[y][x] && rows[y][x] !== '.') return y; return 0; };
    const headTop = Math.min(topAt(Math.floor(cx)), topAt(Math.ceil(cx)));
    // 코·부리·입 줄
    let mouth = rows.findIndex((r) => r.slice(0, 10).includes('n'));
    if (mouth < 0) mouth = rows.findIndex((r) => r.slice(0, 9).includes('a'));
    if (mouth < 0) mouth = rows.findIndex((r, y) => y > top && r.slice(0, 8).includes('mm'));
    let neck = null;
    if (mouth >= 0) {
      const inner = (y) => {
        const r = rows[y] || ''; const lo = Math.ceil(cx - 2.5), hi = Math.floor(cx + 2.5);
        const xs = []; for (let x = lo; x <= hi; x++) if (r[x] && r[x] !== '.' && r[x] !== 'o') xs.push(x);
        return xs;
      };
      // 머리보다 좁아지는 첫 줄(발 줄은 빼고), 없으면 입 바로 아랫줄, 그것도 비면 입 줄
      let y = -1;
      for (let k = mouth + 1; k < rows.length - 2; k++) if (rows[k].search(/[^.]/) >= 2) { y = k; break; }
      if (y < 0 || !inner(y).length) y = inner(mouth + 1).length ? mouth + 1 : mouth;
      const xs = inner(y);
      if (xs.length) neck = { y, x0: xs[0], x1: xs[xs.length - 1] };
    }
    return { cx, top, right, headTop, neck };
  }

  function drawAccessory(grid, rows, id, ox, oy, pose) {
    const acc = ACC[id]; if (!acc) return;
    const a = anchors(rows); if (!a) return;
    const put = (x, y, color) => { const gx = ox + x, gy = oy + y; if (gx >= 0 && gy >= 0 && gx < W && gy < H) grid[gy][gx] = color; };
    const stampAt = (pattern, key, x0, y0) => pattern.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== '.' && key[ch]) put(x0 + x, y0 + y, key[ch]); }));
    if (acc.at === 'side') { const w = acc.rows[0].length, h = acc.rows.length; stampAt(acc.rows, acc.key, a.right + 1 - Math.floor(w / 2), a.top - 2 - Math.floor(h / 2)); return; }
    if (acc.at === 'top') { const w = acc.rows[0].length; stampAt(acc.rows, acc.key, Math.round(a.cx) - Math.floor(w / 2), a.headTop - acc.rows.length + 1); return; }
    // 목 장식: 엎드린 자세에서는 앞발에 가려 보이지 않는다
    if (pose === 'sleep' || !a.neck) return;
    const { y, x0, x1 } = a.neck; const mid = Math.round(a.cx);
    if (acc.rows) { const w = acc.rows[0].length; stampAt(acc.rows, acc.key, mid - Math.floor(w / 2), y - 1); return; }
    for (let x = x0; x <= x1; x++) put(x, y, acc.band[(x - x0) % acc.band.length]);
    if (acc.thick) { for (let x = x0; x <= x1; x++) put(x, y + 1, acc.band[(x - x0 + 1) % acc.band.length]); put(x1, y + 2, acc.band[0]); }
    if (acc.drop) acc.drop.forEach((color, k) => put(mid, y + 1 + k, color));
  }

  /* draw → 칸마다 색(문자열) 또는 null.
     opt: pose('sit'|'sleep'), closed(눈 감음), happy(볼 분홍), dx·dy(옮김), wag(강아지 꼬리 끝을 옆으로 옮길 칸 수)
          awake(엎드린 자세인데 눈 뜨고 쉬기), step(걷는 발 1·2), noPerch(카나리아 횃대 빼기 — 방에서 바닥을 걸을 때), yawn(하품: 입 벌림),
          acc(펫 장식 id: ribbon·flower·crown·pearl·bell·bowtie·scarf) */
  function drawBase(species, stage, colorId, opt = {}) {
    const grid = Array.from({ length: H }, () => new Array(W).fill(null));
    let rows, pal;
    if (stage === 0) { rows = EGGS[species]; pal = EGG_COLORS[species]; }
    else { rows = (opt.pose === 'sleep' ? SLEEP : opt.pose === 'walk' && WALK[species] ? WALK : SPRITES)[species][stage]; pal = COLORS[species].find((c) => c.id === colorId) || COLORS[species][0]; }
    if (stage > 0 && opt.noPerch) { const k = rows.findIndex((r) => r.includes('w')); if (k > 0) rows = rows.slice(0, k); }
    if (stage > 0 && opt.step) rows = lifted(rows, opt.step);
    const w = rows[0].length, h = rows.length;
    const ox = Math.floor((W - w) / 2) + (opt.dx || 0), oy = BASE + 1 - h + (opt.dy || 0);
    const cheek = new Set(stage > 0 && opt.happy ? cheeks(rows).map(([x, y]) => `${x},${y}`) : []);
    const closed = stage > 0 && (opt.closed || (opt.pose === 'sleep' && !opt.awake)) ? closedEyes(rows) : { off: [], line: [] };
    const off = new Set(closed.off.map(([x, y]) => `${x},${y}`)), line = new Set(closed.line.map(([x, y]) => `${x},${y}`));
    // 감은 눈 선이 윤곽에 닿으면(눈 사이가 좁은 고양이) 윤곽보다 밝게 칠해 '- -'로 읽히게
    const touches = closed.line.some(([x, y]) => [x - 1, x + 1].some((nx) => rows[y][nx] === 'o' && !line.has(`${nx},${y}`)));
    const lid = colorId === 'black' ? '#8f8a99' : touches ? mix(pal.f, pal.o, 0.55) : pal.o;
    const tail = stage > 0 && opt.pose !== 'sleep' && opt.wag && TAILS[species] ? TAILS[species][stage] : null;
    // 햄스터 볼 주머니: 코 줄과 그 아래 줄의 왼쪽 윤곽을 한 칸 밖으로(빵빵)
    const noseRow = rows.findIndex((r) => r.includes('n'));
    const puffRows = stage > 0 && opt.puff && noseRow >= 0 ? new Set([noseRow, noseRow + 1]) : new Set();
    // 카나리아 날갯짓: 날개(1) 칸을 한 칸 위로
    const isWing = (x, y) => rows[y] && rows[y][x] === '1';
    // 자는 고양이: 가끔 꼬리 끝(첫 꼬리 줄의 맨 왼쪽 칸)이 위로 움찔
    let twitch = null;
    if (stage > 0 && opt.pose === 'sleep' && opt.twitch) {
      const ty = rows.findIndex((r) => r.includes('t')); if (ty > 0) twitch = [rows[ty].indexOf('t'), ty - 1];
    }
    const striped = pal['1'] && pal['1'] !== pal.f;
    rows.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const key = `${x},${y}`;
      // 자는 자세의 감은 꼬리: 줄무늬 있는 털은 한 칸씩 무늬
      let color = ch === 't' ? (striped && x % 2 === 0 ? pal['1'] : mix(pal.f, pal.o, 0.22)) : pal[ch] ?? pal.f;
      if (ch === 'e' && closed.line.length) color = pal.f;
      if (off.has(key)) color = pal.f;
      if (line.has(key)) color = lid;
      if (cheek.has(key)) color = FX.p;
      // 꼬리 끝 줄은 wag칸, 그 아래 줄은 절반(크기 올림)만 옮겨 비스듬히 휘게
      const half = Math.sign(opt.wag || 0) * Math.ceil(Math.abs(opt.wag || 0) / 2);
      let shift = 0, lift = 0;
      if (tail && tail.axis === 'y') {
        if (y >= tail.rows[0] && y <= tail.rows[1]) lift = x >= tail.x1 ? opt.wag : x >= tail.x0 ? half : 0;
      } else if (tail && tail.lean) {
        if (x >= tail.x0 && y >= tail.rows[0] && y < tail.rows[1]) shift = Math.round(opt.wag * (tail.rows[1] - y) / (tail.rows[1] - tail.rows[0]));
      } else if (tail && x >= tail.x0 && y >= tail.rows[0] && y < tail.rows[0] + 2) shift = y === tail.rows[0] ? opt.wag : half;
      if (opt.flap && species === 'canary') { if (isWing(x, y + 1)) color = pal['1']; else if (ch === '1') color = pal.f; }
      if (opt.sniff && ch === 'n') color = mix(pal.n, pal.o, 0.35);
      if (puffRows.has(y) && x === row.search(/[^.]/) && ch === 'o') {
        color = pal.m; const px = ox + x - 1, py = oy + y;
        if (px >= 0 && py >= 0 && px < W && py < H) grid[py][px] = pal.o;
      }
      if (twitch && x === twitch[0] && y === twitch[1]) color = mix(pal.f, pal.o, 0.22);
      const gx = ox + x + shift, gy = oy + y - lift;
      if (gx >= 0 && gy >= 0 && gx < W && gy < H) grid[gy][gx] = color;
    }));
    // 하품: 코 바로 아래 칸(코가 없으면 부리 아래, 그것도 없으면 머리 쪽 밝은 줄 가운데)을 벌린 입으로
    if (stage > 0 && opt.yawn) {
      let mouth = [];
      const ny = rows.findIndex((r) => r.includes('n'));
      const ay = rows.findIndex((r) => r.slice(0, 9).includes('a'));
      if (ny >= 0) mouth = [...rows[ny]].map((ch, x) => (ch === 'n' ? [x, ny + 1] : null)).filter(Boolean);
      else if (ay >= 0) mouth = [...rows[ay]].map((ch, x) => (ch === 'a' && x < 9 ? [x, ay + 1] : null)).filter(Boolean);
      else {
        const my = rows.findIndex((r) => r.slice(0, 8).includes('mm'));
        if (my >= 0) { const r = rows[my].slice(0, 8); const a = r.indexOf('m'), b = r.lastIndexOf('m'); const c = Math.floor((a + b) / 2); mouth = [[c, my], [c + 1, my]]; }
      }
      for (const [x, y] of mouth) { const gx = ox + x, gy = oy + y; if (gx >= 0 && gy >= 0 && gx < W && gy < H) grid[gy][gx] = '#a23048'; }
    }
    // 도마뱀 혀 날름: 턱 가운데 아래로 분홍 두 칸
    if (stage > 0 && opt.tongue) {
      const chin = rows.findIndex((r, y) => y > 0 && r.slice(0, 8).includes('m') && !(rows[y + 1] || '').slice(0, 8).includes('m'));
      if (chin >= 0) for (const [dx, dy] of [[3, 1], [4, 1], [4, 2]]) { const gx = ox + dx, gy = oy + chin + dy; if (gx < W && gy < H) grid[gy][gx] = '#ff5f87'; }
    }
    if (stage > 0 && opt.acc) drawAccessory(grid, rows, opt.acc, ox, oy, opt.pose);
    return grid;
  }

  const HEART = ['h.h', 'hhh', '.h.'];
  const SPARK = ['.s.', 'sSs', '.s.'];
  const BOWL = ['.kkkk.', 'yYYYYy', '.yyyy.']; // 사료(k)는 먹을수록 줄어든다
  function stamp(grid, ox, oy, rows) {
    rows.forEach((row, y) => [...row].forEach((ch, x) => { const gx = ox + x, gy = oy + y; if (ch !== '.' && gx >= 0 && gy >= 0 && gx < W && gy < H) grid[gy][gx] = FX[ch]; }));
  }
  const topOf = (grid) => { for (let y = 0; y < H; y++) if (grid[y].some(Boolean)) return y; return 0; };
  const ACTIONS = { idle: 48, sleep: 48, pet: 24, feed: 36, hatch: 36, grow: 24 };
  const ZED = ['zzzz', '...z', '..z.', '.z..', 'zzzz'];
  const HOP = [0, -1, -2, -1, 0];
  /* 종별 습성: 토끼는 높이 뛰고(빙키), 거북이는 뛰지 않고 천천히 끄덕인다 */
  const HOPS = { rabbit: [0, -2, -3, -3, -2, 0], turtle: [0, 0, 1, 1, 0, 0] };
  const hopOf = (species, i) => { const h = HOPS[species] || HOP; return h[((i % h.length) + h.length) % h.length]; };
  /* 기분 좋을 때 덧붙는 몸짓: 카나리아 날갯짓, 도마뱀 혀 날름 */
  const happyExtras = (species, f) => ({ flap: species === 'canary' && Math.floor(f / 2) % 2 === 1, tongue: species === 'lizard' && f % 8 < 3 });
  const NOTE = ['.qq', '.q.', 'qq.', 'qq.']; // 카나리아 노래(음표)

  /* scene(species, stage, color, action, f, {to}) → 12fps 프레임 f의 칸 색 */
  function scene(species, stage, color, action, f, o = {}) {
    const draw = (sp, st, c, opt = {}) => drawBase(sp, st, c, { noPerch: o.noPerch, acc: o.acc, ...opt });
    if (action === 'hatch') {
      if (f < 12) return draw(species, 0, color, { dx: [0, -1, 0, 1][Math.floor(f / 2) % 4] });
      if (f < 18) { const g = draw(species, 0, color, { dy: f % 2 ? -1 : 0 }); stamp(g, 8, 15 + (f % 2 ? -1 : 0), ['w.w.w']); return g; }
      const g = draw(species, 1, color, { ...happyExtras(species, f), happy: true, wag: TAIL_MOVES[species].happy(f), dy: f < 24 ? hopOf(species, f - 18) : 0 });
      for (const [x, y, k] of [[3, 8, 0], [16, 7, 1], [2, 14, 2], [17, 13, 3]]) if ((f + k) % 4 < 3) stamp(g, x, y - Math.floor((f - 18) / 6), SPARK);
      return g;
    }
    if (action === 'grow') {
      const now = f < 10 ? stage : (o.to ?? Math.min(3, stage + 1));
      const g = draw(species, now, color, { ...(f >= 10 ? happyExtras(species, f) : {}), happy: f >= 10, wag: f >= 10 ? TAIL_MOVES[species].happy(f) : TAIL_MOVES[species].calm(f), dy: f >= 10 && f < 16 ? hopOf(species, f - 10) : 0 });
      if (f >= 6 && f < 12 && f % 2 === 0) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y][x]) g[y][x] = FX.w;
      for (const [x, y, k] of [[1, 8, 0], [18, 6, 1], [2, 14, 2], [18, 13, 3]]) if (f >= 8 && (f + k) % 4 < 3) stamp(g, x, y - Math.floor((f - 8) / 5), SPARK);
      return g;
    }
    // 알은 쓰다듬기·먹이 주기·잠 없이 가만히(부화만)
    if (stage === 0 && action !== 'hatch') return draw(species, 0, color, { dx: f % 48 >= 40 ? [0, -1, 0, 1][Math.floor(f / 2) % 4] : 0 });
    if (action === 'pet') {
      const hops = HOPS[species] || HOP;
      const g = draw(species, stage, color, { ...happyExtras(species, f), happy: true, closed: true, wag: TAIL_MOVES[species].happy(f), dy: f % (hops.length * 2) < hops.length ? hopOf(species, f) : 0 });
      const top = topOf(g);
      const sx = Math.floor((W - SPRITES[species][stage][0].length) / 2);
      const glyph = species === 'canary' ? NOTE : HEART;
      for (const [x0, k] of [[sx + 1, 0], [sx + 7, 7], [sx + 4, 13]]) { const t = f - k; if (t >= 0 && t < 11) stamp(g, x0, top - glyph.length + 1 - Math.floor(t / 2), glyph); }
      return g;
    }
    if (action === 'feed') {
      const eating = f >= 4 && f < 26;
      // 먹는 동안: 햄스터는 볼이 빵빵, 도마뱀은 혀 날름
      const eatExtras = eating ? { puff: species === 'hamster' && f >= 10, tongue: species === 'lizard' && f % 6 < 2 } : {};
      const g = draw(species, stage, color, { ...(f >= 26 ? happyExtras(species, f) : eatExtras), happy: f >= 26, closed: eating && f % 6 < 3, wag: f >= 26 ? TAIL_MOVES[species].happy(f) : eating ? TAIL_MOVES[species].still(f) : TAIL_MOVES[species].calm(f), dy: eating && f % 6 < 3 ? 1 : f >= 26 ? hopOf(species, f - 26) : 0 });
      const left = Math.max(0, 4 - Math.floor(Math.max(0, f - 4) / 5.5));
      const bowl = ['.' + 'k'.repeat(left).padEnd(4, '.') + '.', BOWL[1], BOWL[2]];
      const sprite = SPRITES[species][stage]; const sx = Math.floor((W - sprite[0].length) / 2);
      stamp(g, sx + 1, BASE - 2, bowl); // 머리 아래 앞쪽에 놓인 먹이통
      if (f >= 28) { const glyph = species === 'canary' ? NOTE : HEART; stamp(g, sx + 3, topOf(g) - glyph.length + 1 - Math.floor((f - 28) / 2), glyph); }
      return g;
    }
    // 잠: 엎드려 눈을 감고, 머리 위로 z가 하나씩 떠오른다
    if (action === 'sleep' && stage > 0) {
      const g = draw(species, stage, color, { pose: 'sleep', twitch: species === 'cat' && f % 24 >= 18 && f % 24 < 21 });
      const rows = SLEEP[species][stage]; const sx = Math.floor((W - rows[0].length) / 2), sy = BASE + 1 - rows.length;
      const t = f % 24; const step = Math.floor(t / 6); // Z 하나가 4칸 떠오르고 다음 Z로
      stamp(g, sx + 8 + step, sy - 4 - step, ZED);
      return g;
    }
    // 가만히: 가끔 눈 깜빡임
    if (stage === 0) return draw(species, 0, color, { dx: f % 48 >= 40 ? [0, -1, 0, 1][Math.floor(f / 2) % 4] : 0 });
    // 평소 습성: 햄스터는 코를 씰룩, 도마뱀은 가끔 혀 날름, 카나리아는 가끔 깃을 고른다(날개 들썩)
    return draw(species, stage, color, {
      closed: f % 48 >= 44 && f % 48 < 46, wag: TAIL_MOVES[species].calm(f),
      sniff: species === 'hamster' && f % 16 < 3, tongue: species === 'lizard' && f % 48 >= 34 && f % 48 < 38,
      flap: species === 'canary' && f % 48 >= 22 && f % 48 < 26 && f % 2 === 0,
    });
  }

  const draw = drawBase;
  return { W, H, COLORS, STAGES, ACTIONS, SPRITES, SLEEP, WALK, ACCESSORIES: Object.keys(ACC), draw, scene, TAIL_MOVES, HOPS, hopOf, happyExtras };
})();
export default PETS;

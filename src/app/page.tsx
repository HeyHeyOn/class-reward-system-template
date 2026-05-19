const sampleProducts = [
  { name: '연필', price: 300, stock: 20, category: '문구' },
  { name: '지우개', price: 500, stock: 15, category: '문구' },
  { name: '스티커', price: 700, stock: 10, category: '꾸미기' },
  { name: '간식쿠폰', price: 1000, stock: 5, category: '쿠폰' },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f6f1e8] text-slate-950">
      <section className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-6 py-8 lg:px-10">
        <header className="flex flex-col gap-4 rounded-[2rem] bg-white/85 p-6 shadow-sm ring-1 ring-black/5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-bold tracking-[0.3em] text-amber-700">CLASS STORE</p>
            <h1 className="mt-2 text-4xl font-black tracking-tight md:text-6xl">학급 매점</h1>
            <p className="mt-3 text-lg text-slate-600">QR을 찍고, 상품을 담고, 학급 화폐로 결제합니다.</p>
          </div>
          <div className="flex flex-col gap-3 rounded-3xl bg-slate-950 px-6 py-4 text-white shadow-lg">
            <div>
              <p className="text-sm text-slate-300">현재 모드</p>
              <p className="text-2xl font-black">MVP 준비 중</p>
            </div>
            <a href="/admin/settings" className="rounded-full bg-amber-300 px-4 py-2 text-center font-black text-slate-950">
              관리자 설정
            </a>
          </div>
        </header>

        <div className="grid flex-1 gap-8 lg:grid-cols-[1fr_420px]">
          <section className="rounded-[2rem] bg-slate-950 p-6 text-white shadow-xl">
            <div className="flex h-full min-h-[520px] flex-col items-center justify-center rounded-[1.5rem] border-4 border-dashed border-white/20 bg-white/5 p-8 text-center">
              <div className="mb-8 grid h-52 w-52 place-items-center rounded-[2rem] bg-white text-slate-950 shadow-2xl">
                <div className="grid h-40 w-40 grid-cols-3 gap-2">
                  {Array.from({ length: 9 }).map((_, index) => (
                    <div
                      key={index}
                      className={index % 2 === 0 ? 'rounded-lg bg-slate-950' : 'rounded-lg bg-amber-300'}
                    />
                  ))}
                </div>
              </div>
              <h2 className="text-4xl font-black">QR 코드를 보여 주세요</h2>
              <p className="mt-4 max-w-xl text-lg text-slate-300">
                실제 구현에서는 이 영역에 카메라 미리보기와 QR 인식기가 들어갑니다.
              </p>
              <button className="mt-8 rounded-full bg-amber-300 px-8 py-4 text-xl font-black text-slate-950 shadow-lg transition hover:bg-amber-200">
                테스트 학생 S001 불러오기
              </button>
            </div>
          </section>

          <aside className="flex flex-col gap-6">
            <section className="rounded-[2rem] bg-white p-6 shadow-sm ring-1 ring-black/5">
              <p className="text-sm font-bold text-slate-500">학생 정보</p>
              <div className="mt-4 rounded-3xl bg-amber-50 p-5">
                <p className="text-2xl font-black">김민준 · 1번</p>
                <p className="mt-2 text-slate-600">현재 잔액</p>
                <p className="text-5xl font-black text-amber-700">3,500</p>
              </div>
            </section>

            <section className="rounded-[2rem] bg-white p-6 shadow-sm ring-1 ring-black/5">
              <div className="flex items-center justify-between">
                <p className="text-xl font-black">상품 목록</p>
                <p className="text-sm text-slate-500">Google Sheets 연동 예정</p>
              </div>
              <div className="mt-4 grid gap-3">
                {sampleProducts.map((product) => (
                  <div key={product.name} className="flex items-center justify-between rounded-2xl bg-slate-50 p-4">
                    <div>
                      <p className="font-black">{product.name}</p>
                      <p className="text-sm text-slate-500">
                        {product.category} · 재고 {product.stock}
                      </p>
                    </div>
                    <button className="rounded-full bg-slate-950 px-4 py-2 font-bold text-white">
                      {product.price.toLocaleString()}원
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[2rem] bg-white p-6 shadow-sm ring-1 ring-black/5">
              <p className="text-xl font-black">장바구니</p>
              <div className="mt-4 rounded-2xl bg-slate-100 p-4 text-slate-500">선택한 상품이 없습니다.</div>
              <button className="mt-4 w-full rounded-2xl bg-emerald-500 py-4 text-xl font-black text-white shadow-lg">
                결제 준비
              </button>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}

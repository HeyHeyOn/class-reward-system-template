# Carousel Interaction Polish Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make task carousel indicators track the card that is at least halfway visible, make indicator taps respond immediately with a visible smooth animation, and prevent idle-settle logic from snapping a card while the user is still holding a drag.

**Architecture:** Separate transient visual position from durable settled position. A pure position-to-index helper drives the indicator and slide accessibility state whenever the scroll position crosses a 50% boundary, while durable `activeTaskId` persistence happens only after a genuine interaction end. Programmatic indicator navigation uses one cancellable animation controller that temporarily avoids scroll-snap interference, updates visual state at threshold crossings, and restores exact snapping only at completion.

**Tech Stack:** Next.js 16, React, TypeScript, Tailwind CSS, Vitest, Testing Library, browser/mobile manual verification.

---

## Confirmed root causes and open hypothesis

1. **Indicator lag is confirmed:** `TaskCarousel` updates `activeIndex` only through `persistScrolledIndex()`, which runs on `scrollend` or a 160 ms idle fallback. `onScroll` intentionally does not update visual state, and programmatic animation persists only at its final frame.
2. **Held-drag snap is confirmed:** the 160 ms `onScroll` fallback runs even while a pointer remains down. It persists the rounded index; the parent changes `activeTaskId`; the external-index effect then calls `scrollTaskCarousel()` and teleports to the rounded card.
3. **Indicator-tap no-animation/delay needs real-browser reproduction:** component tests prove the requestAnimationFrame path in JSDOM, but do not prove mobile pointer/click timing or CSS `scroll-snap-type: mandatory` interaction. The implementation must not guess between delayed click dispatch and browser snap interference; capture both before changing behavior.

## Acceptance criteria

- At less than 50% transition, the current indicator remains selected.
- At 50% or more transition, the adjacent indicator becomes selected during the movement, not after settling.
- Holding a drag indefinitely at any position never invokes durable persistence and never causes programmatic snapping.
- Releasing at rest persists the nearest card once; momentum scroll persists only after it settles.
- Pressing an indicator on touch/pen gives immediate visual response and visibly animates to the target.
- Mouse click and keyboard activation remain accessible and do not double-trigger.
- During a multi-card indicator jump, the indicator advances whenever each card crosses its halfway boundary.
- Programmatic motion is cancellable by touch, pointer drag, wheel, or trackpad without a later stale frame/timer snapping the carousel.
- `prefers-reduced-motion: reduce` still moves immediately and updates visual/durable state exactly once.
- Existing one-slide native swipe stop, position restoration, filled dots, desktop arrows, completed/locked overlays, and vertical list preservation remain unchanged.
- No Padlet or database code is introduced.

---

### Task 1: Extract and test carousel position math

**Objective:** Give swipe and scripted animation one authoritative, boundary-tested index calculation.

**Files:**
- Modify: `src/components/BankApp.tsx:657-799`
- Test: `src/components/BankApp.test.tsx:603-789`

**Step 1: Write failing tests**

Add table-driven tests for a helper contract equivalent to:

```ts
visualSlideIndex({ scrollLeft: 49, slideWidth: 100, slideCount: 4 }) === 0
visualSlideIndex({ scrollLeft: 50, slideWidth: 100, slideCount: 4 }) === 1
visualSlideIndex({ scrollLeft: 149, slideWidth: 100, slideCount: 4 }) === 1
visualSlideIndex({ scrollLeft: 150, slideWidth: 100, slideCount: 4 }) === 2
```

Also cover negative overscroll, right-edge overscroll, zero width, and one-card carousels.

**Step 2: Verify RED**

Run:

```bash
npx vitest run src/components/BankApp.test.tsx -t "carousel visual index"
```

Expected: FAIL because no shared threshold helper exists.

**Step 3: Implement the minimal helper**

Use nearest-slide semantics (`Math.round(scrollLeft / slideWidth)`) with finite-value validation and `[0, slideCount - 1]` clamping. Do not normalize the DOM position or write to the scroller in this helper.

**Step 4: Verify GREEN**

Run the same focused command; expected PASS.

---

### Task 2: Split transient visual state from durable settled state

**Objective:** Update indicators at the halfway threshold without treating an in-progress drag as settled navigation.

**Files:**
- Modify: `src/components/BankApp.tsx:657-755`
- Test: `src/components/BankApp.test.tsx:603-648`

**Step 1: Write failing component tests**

Add tests proving:

- `scrollLeft=49` keeps indicator 1 active.
- `scrollLeft=50` immediately activates indicator 2 before `scrollend`.
- crossing back below 50 immediately restores indicator 1.
- transient threshold changes do not call durable `onActiveTaskChange` until settle.
- repeated scroll events inside the same card do not cause redundant state/persistence work.

**Step 2: Verify RED**

Run:

```bash
npx vitest run src/components/BankApp.test.tsx -t "halfway|transient carousel"
```

Expected: current implementation keeps the old indicator until settle.

**Step 3: Implement separate state paths**

- Rename the rendered state concept to `visualIndex`.
- Keep durable parent persistence in a separate `persistSettledIndex()` path.
- On every user or scripted position update, calculate the threshold index and call `setVisualIndex()` only when the index changes.
- Use `visualIndex` for `aria-current`, slide `inert`, `aria-hidden`, and arrow disabled state.
- Do not call `onActiveTaskChange` from the visual update path.

**Step 4: Verify GREEN**

Run focused tests and the existing navigation/indicator tests.

---

### Task 3: Model pointer-held, momentum, scripted, and settled phases

**Objective:** Prevent idle timers and external-state effects from snapping while a drag is still active.

**Files:**
- Modify: `src/components/BankApp.tsx:662-755`
- Test: `src/components/BankApp.test.tsx:603-763`

**Step 1: Write failing tests**

Using fake timers, prove:

1. Pointer down → scroll past 50% → hold for more than 160 ms: indicator changes, but scroller position is unchanged and durable position is not persisted.
2. Pointer up while stationary: nearest card persists after the fallback delay without an intermediate teleport.
3. Pointer up followed by momentum scroll: each scroll resets the idle timer; persistence occurs once after motion stops.
4. `pointercancel` safely enters the same settle path.
5. `scrollend` persists immediately only when no pointer is held.

**Step 2: Verify RED**

Run:

```bash
npx vitest run src/components/BankApp.test.tsx -t "held drag|momentum|pointercancel"
```

Expected: held drag currently fires the 160 ms persistence path.

**Step 3: Implement explicit interaction refs**

- Add refs for pointer-held state, scripted-animation state/generation, and settle timer.
- On primary `pointerdown`, cancel scripted motion and clear settle timers; mark pointer held.
- While pointer held, `onScroll` updates only `visualIndex`; it must not schedule persistence.
- On `pointerup`/`pointercancel`, clear pointer-held and begin the idle fallback.
- After release, momentum `onScroll` resets that fallback.
- `scrollend` and fallback both pass through one idempotent settle function.
- Remove duplicate touch handling when Pointer Events already cover the platform; retain a bounded fallback only if a tested browser requires it.

**Step 4: Guard external synchronization**

When the parent echoes the just-persisted `activeTaskId`, do not call `scrollTaskCarousel()` if the DOM is already within a small pixel tolerance of that slide. Never externally realign while pointer-held or while a current scripted generation owns motion.

**Step 5: Verify GREEN**

Run all carousel-focused tests.

---

### Task 4: Reproduce and fix indicator press startup on real browser semantics

**Objective:** Make touch/pen indicator activation immediate while preserving mouse and keyboard behavior.

**Files:**
- Modify: `src/components/BankApp.tsx:696-784`
- Test: `src/components/BankApp.test.tsx:668-789`

**Step 1: Add temporary browser evidence**

In a local production/dev build, capture event order and timestamps for indicator `pointerdown`, `pointerup`, `click`, first animation frame, `scroll`, and scroll position. Test at least Chrome mobile emulation and one real touch browser if available. Do not log task/student data.

**Step 2: Classify the cause**

- If `click` is delayed after pointer release, use immediate touch/pen pointer activation with duplicate-click suppression while retaining normal `onClick` for mouse/keyboard.
- If animation frames run but mandatory scroll snap collapses them, suspend snap only for the scripted animation generation and restore it at exact completion/cancellation.
- If both occur, apply both narrow fixes with separate tests.

**Step 3: Write failing tests for the observed cause**

Cover:

- one touch/pen press starts exactly one animation without waiting for synthetic click;
- subsequent click does not start a duplicate generation;
- keyboard Enter/Space still uses the button click path;
- a second indicator press cancels the old generation and starts from the current pixel position;
- no stale RAF callback can finish the cancelled generation.

**Step 4: Implement one animation controller**

- Give each scripted animation a monotonically increasing generation token.
- Cancel the prior RAF before reading the new start position.
- Drive pixel position directly for each frame and update `visualIndex` from the same position.
- Temporarily disable snap only if browser evidence proves snap interference; restore the original snap mode on completion and every cancellation path.
- Set the exact final position, visual index, and durable position once at completion.
- Preserve the fixed total duration unless browser evidence supports a small tuning change.

**Step 5: Verify GREEN**

Run indicator, interruption, repeated-press, and reduced-motion tests.

---

### Task 5: Optimize rendering and accessibility

**Objective:** Keep the smoother behavior cheap and accessible.

**Files:**
- Modify: `src/components/BankApp.tsx:657-784`
- Test: `src/components/BankApp.test.tsx`

**Steps:**

1. Assert `setVisualIndex` is effectively threshold-based, not called for every pixel/frame when the nearest index is unchanged.
2. Keep DOM scroll position in refs; do not put raw `scrollLeft` in React state.
3. Verify exactly one indicator has `aria-current=true` at all times.
4. Verify the more-than-half-visible slide alone is non-`inert`.
5. Verify focus-visible behavior and keyboard indicator activation.
6. Verify reduced motion performs no RAF and does not double-persist.

Run:

```bash
npx vitest run src/components/BankApp.test.tsx
```

Expected: all BankApp tests pass.

---

### Task 6: Browser acceptance matrix and release gates

**Objective:** Prove the fixes under real scrolling physics before publishing the template.

**Files:**
- Modify only if tests expose a defect: `src/components/BankApp.tsx`, `src/components/BankApp.test.tsx`

**Manual/browser matrix:**

- Slow drag to 49%, hold, return.
- Slow drag to 51%, hold for at least one second, then release.
- Fast swipe with momentum.
- Indicator jump by one card and across four or more cards.
- Repeated rapid indicator presses.
- Touch interruption halfway through indicator animation.
- Trackpad/wheel interruption.
- First and last card overscroll.
- Reduced-motion mode.
- Open detail and return; current slide and vertical list position remain stable.

**Automated gates:**

```bash
npx vitest run src/components/BankApp.test.tsx
npm test -- --run
npm run lint
npm run build
npm audit --omit=dev

git diff --check
```

**Review gates:**

1. Specification review against all three reported symptoms.
2. Quality/accessibility/performance review focused on stale timers, RAF generations, pointer lifecycle, snap restoration, and unnecessary React renders.
3. Commit and push only the UI source/test changes after both reviews approve.

---

## Implementation order after approval

1. Implement and publish this carousel polish on the Google Sheets template.
2. Restore the Sheets-based Padlet integration in a separate change, including the documented ISO-8601 timestamp compatibility fix and live Padlet/Upstash E2E.
3. Resume the paused PostgreSQL multi-tenant migration only after the Sheets template is verified and stable.

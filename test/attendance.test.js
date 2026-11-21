const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const AttendanceCalc = require('../attendance-calc.js');
const { calculateCourseMetrics, calculateSemesterSummary } = AttendanceCalc;

// Old logic implementation to demonstrate and reproduce bugs
function oldLogicCourse(c) {
  const total = c.present + c.absent; // ignores leave
  const pct = total > 0 ? +(c.present / total * 100).toFixed(2) : 0;
  const rem = c.scheduled > 0 ? Math.max(0, c.scheduled - total) : 0;
  let status = '';
  if (total === 0) {
    status = 'not marked yet';
  } else if (pct >= 75) {
    const rawSafeNow = Math.floor((c.present - 0.75 * total) / 0.75);
    const safeNow = c.scheduled > 0 ? Math.min(rem, Math.max(0, rawSafeNow)) : Math.max(0, rawSafeNow);
    if (c.scheduled > 0 && rem === 0) status = 'completed';
    else if (safeNow > 0) status = 'safe bunks ' + safeNow;
    else status = 'on edge 0 bunks';
  } else {
    const rawNeed = Math.max(0, Math.ceil(3 * c.absent - c.present));
    if (c.scheduled > 0 && rem === 0) status = 'short attendance';
    else status = 'attend ' + rawNeed + ' classes';
  }
  return { total, pct, remaining: rem, status };
}

function oldLogicSummary(courses) {
  let p = 0, a = 0, l = 0, sched = 0, rem = 0;
  for (const c of courses) {
    const old = oldLogicCourse(c);
    p += c.present || 0;
    a += c.absent || 0;
    l += c.leave || 0;
    sched += c.scheduled || 0;
    rem += old.remaining;
  }
  const tot = p + a;
  const pct = tot > 0 ? +((p / tot) * 100).toFixed(2) : 0;
  return {
    present: p,
    absent: a,
    leave: l,
    held: tot,
    remaining: rem,
    scheduled: sched,
    pct,
    isConsistent: (tot + rem === sched),
  };
}

describe('Attendance Calculation Bug Reproductions & Fixes', () => {

  // Anonymized sample fixture matching observed data
  const sampleData = [
    { name: 'Course 1 (Unmarked)', present: 0, absent: 0, leave: 0, scheduled: 42 },
    { name: 'Course 2 (Leaves & Below Threshold)', present: 21, absent: 21, leave: 6, scheduled: 47 },
    { name: 'Course 3 (Held Exceeds Scheduled)', present: 34, absent: 15, leave: 0, scheduled: 45 },
    { name: 'Course 4 (100% Attendance Theory)', present: 7, absent: 0, leave: 0, scheduled: 45 },
    { name: 'Course 5 (100% Attendance Lab)', present: 3, absent: 0, leave: 0, scheduled: 14 },
  ];

  describe('Bug 1: Course where held exceeds scheduled (WSN)', () => {
    it('demonstrates bug in old logic (stale scheduled total 45, held 49, no discrepancy flag)', () => {
      const old = oldLogicCourse(sampleData[2]);
      assert.equal(old.total, 49);
      assert.equal(old.remaining, 0);
      // In the old UI, this was shown as "0 of 45" left despite 49 classes taken
      assert.equal(sampleData[2].scheduled, 45);
      assert.ok(old.total > sampleData[2].scheduled);
    });

    it('fixes bug 1: detects discrepancy, reconciles effective total to 49, sets warning flag', () => {
      const fixed = calculateCourseMetrics(sampleData[2]);
      assert.equal(fixed.held, 49);
      assert.equal(fixed.scheduled, 45);
      assert.equal(fixed.remaining, 0);
      assert.equal(fixed.effectiveTotal, 49);
      assert.equal(fixed.hasScheduleDiscrepancy, true);
      assert.match(fixed.discrepancyMessage, /exceed scheduled classes/i);
    });
  });

  describe('Bug 2: Semester summary total mismatch (101 held + 96 left = 197 != 193)', () => {
    it('demonstrates bug in old logic (sum of held 101 + remaining 96 != scheduled 193)', () => {
      const oldSummary = oldLogicSummary(sampleData);
      assert.equal(oldSummary.held, 101);
      assert.equal(oldSummary.remaining, 96);
      assert.equal(oldSummary.scheduled, 193);
      assert.equal(oldSummary.held + oldSummary.remaining, 197);
      // Old logic was mathematically inconsistent!
      assert.equal(oldSummary.isConsistent, false);
    });

    it('fixes bug 2: reconciled summary guarantees held + remaining === scheduled', () => {
      const summary = calculateSemesterSummary(sampleData);
      assert.equal(summary.held, 107); // 0 + 48 + 49 + 7 + 3 = 107
      assert.equal(summary.remaining, 91); // 42 + 0 + 0 + 38 + 11 = 91
      assert.equal(summary.scheduled, 198); // 42 + 48 + 49 + 45 + 14 = 198
      assert.equal(summary.held + summary.remaining, summary.scheduled);
      assert.equal(summary.isConsistent, true);
      assert.equal(summary.hasAnyDiscrepancy, true);
    });
  });

  describe('Bug 3: Leave handling consistency (Cryptography)', () => {
    it('demonstrates bug in old logic (ignores 6 leaves, computes 47-42=5 left, 48 held + 5 left = 53 of 47)', () => {
      const old = oldLogicCourse(sampleData[1]);
      assert.equal(old.total, 42); // Dropped the 6 leaves!
      assert.equal(old.pct, 50.00); // 21/42 ignored the leaves
      assert.equal(old.remaining, 5); // 47 - 42 = 5
      // 48 actual records + 5 left = 53, but course total was 47!
      const actualHeld = sampleData[1].present + sampleData[1].absent + sampleData[1].leave;
      assert.equal(actualHeld + old.remaining, 53);
      assert.notEqual(actualHeld + old.remaining, sampleData[1].scheduled);
    });

    it('fixes bug 3: counts leaves in held, reconciles remaining, total, and percentage consistently', () => {
      const fixed = calculateCourseMetrics(sampleData[1]);
      assert.equal(fixed.held, 48); // 21 + 21 + 6 = 48
      assert.equal(fixed.remaining, 0); // 48 >= 47 scheduled, so 0 left
      assert.equal(fixed.effectiveTotal, 48);
      assert.equal(fixed.pct, 43.75); // 21 / 48 = 43.75%
      assert.equal(fixed.held + fixed.remaining, fixed.effectiveTotal);
      assert.equal(fixed.hasScheduleDiscrepancy, true);
    });

    it('supports alternative leave rule "excused" consistently', () => {
      const excused = calculateCourseMetrics(sampleData[1], { leaveRule: 'excused' });
      assert.equal(excused.held, 48);
      assert.equal(excused.evaluatedHeld, 42);
      assert.equal(excused.pct, 50.00);
      assert.equal(excused.remaining, 0);
      assert.equal(excused.effectiveTotal, 48);
    });

    it('supports alternative leave rule "credit" consistently', () => {
      const credited = calculateCourseMetrics(sampleData[1], { leaveRule: 'credit' });
      assert.equal(credited.held, 48);
      assert.equal(credited.evaluatedAttended, 27);
      assert.equal(credited.pct, 56.25);
    });
  });

  describe('Bug 4: Feasibility check for attendance recovery', () => {
    it('demonstrates bug in old logic (shows "attend 42 classes" with only 5 left, or "short attendance" with 0 left)', () => {
      // With 5 remaining classes:
      const oldWith5Left = oldLogicCourse({ present: 21, absent: 21, leave: 0, scheduled: 47 });
      assert.equal(oldWith5Left.status, 'attend 42 classes');
      assert.equal(oldWith5Left.remaining, 5);
      // "attend 42 classes" when only 5 are left is impossible!

      // With 0 remaining classes:
      const oldWith0Left = oldLogicCourse({ present: 34, absent: 15, leave: 0, scheduled: 45 });
      assert.equal(oldWith0Left.status, 'short attendance');
    });

    it('fixes bug 4: shows "cannot reach 75%" when required > remaining', () => {
      // Case 1: 21 P, 21 A, 5 left, 47 sched
      const cryptoWith5Left = calculateCourseMetrics({ present: 21, absent: 21, leave: 0, scheduled: 47, remaining: 5 });
      assert.equal(cryptoWith5Left.requiredClasses, 42);
      assert.equal(cryptoWith5Left.remaining, 5);
      assert.equal(cryptoWith5Left.canReachThreshold, false);
      assert.equal(cryptoWith5Left.statusLabel, 'cannot reach 75%');
      assert.equal(cryptoWith5Left.statusType, 'bad');

      // Case 2: WSN with 0 left
      const wsn = calculateCourseMetrics(sampleData[2]);
      assert.equal(wsn.requiredClasses, 11);
      assert.equal(wsn.remaining, 0);
      assert.equal(wsn.canReachThreshold, false);
      assert.equal(wsn.statusLabel, 'cannot reach 75%');
      assert.equal(wsn.statusType, 'bad');
    });

    it('shows "attend N classes" when recovery is feasible', () => {
      // 10 P, 5 A, 20 remaining, 35 scheduled
      // k >= ceil((0.75*15 - 10) / 0.25) = ceil(1.25 / 0.25) = 5
      const feasible = calculateCourseMetrics({ present: 10, absent: 5, leave: 0, scheduled: 35, remaining: 20 });
      assert.equal(feasible.requiredClasses, 5);
      assert.equal(feasible.canReachThreshold, true);
      assert.equal(feasible.statusLabel, 'attend 5 classes');
      assert.equal(feasible.statusType, 'bad');
    });
  });

  describe('Bug 5: Safe bunks formula using semester total', () => {
    it('demonstrates bug in old logic (computed from classes held so far: 7 held -> 2 bunks, 3 held -> 1 bunk)', () => {
      const oldCourse4 = oldLogicCourse(sampleData[3]);
      assert.equal(oldCourse4.status, 'safe bunks 2');

      const oldCourse5 = oldLogicCourse(sampleData[4]);
      assert.equal(oldCourse5.status, 'safe bunks 1');
    });

    it('fixes bug 5: Course 4 safe bunks = 45 - ceil(0.75*45) - 0 = 11', () => {
      const fixedCourse4 = calculateCourseMetrics(sampleData[3]);
      // 45 - ceil(33.75) - 0 = 45 - 34 = 11
      assert.equal(fixedCourse4.safeBunks, 11);
      assert.equal(fixedCourse4.statusLabel, 'safe bunks 11');
      assert.equal(fixedCourse4.statusType, 'ok');
    });

    it('fixes bug 5: Course 5 safe bunks = 14 - ceil(0.75*14) - 0 = 3', () => {
      const fixedCourse5 = calculateCourseMetrics(sampleData[4]);
      // 14 - ceil(10.5) - 0 = 14 - 11 = 3
      assert.equal(fixedCourse5.safeBunks, 3);
      assert.equal(fixedCourse5.statusLabel, 'safe bunks 3');
      assert.equal(fixedCourse5.statusType, 'ok');
    });

    it('labels clearly as "(right now)" when semester schedule is unknown (scheduled === 0)', () => {
      const unknownSched = calculateCourseMetrics({ present: 7, absent: 0, leave: 0, scheduled: 0 });
      // rawSafeNow = floor((7 - 0.75*7)/0.75) = 2
      assert.equal(unknownSched.safeBunks, 2);
      assert.equal(unknownSched.statusLabel, 'safe bunks 2 (right now)');
      assert.match(unknownSched.projMsg, /right now/i);
    });

    it('shows "on edge 0 bunks" when attendance is exactly on the edge', () => {
      // 30 P, 10 A, 40 scheduled, 0 remaining -> completed
      // 30 P, 10 A, 45 scheduled, 5 remaining -> total 45, min needed = ceil(0.75*45)=34, max abs = 11.
      // absent = 10, safe bunks = 11 - 10 = 1
      // If absent = 11: min needed = 34, max abs = 11, absent = 11 -> safe bunks = 0
      const onEdge = calculateCourseMetrics({ present: 34, absent: 11, leave: 0, scheduled: 45, remaining: 0 });
      assert.equal(onEdge.statusLabel, 'completed');

      const onEdgeFuture = calculateCourseMetrics({ present: 30, absent: 10, leave: 0, scheduled: 41, remaining: 1 });
      // held = 40, pct = 30/40 = 75.00%. effectiveTotal = 41. minNeeded = ceil(0.75*41) = 31. maxAbsent = 41-31 = 10. absent = 10. safe = 0.
      assert.equal(onEdgeFuture.pct, 75.00);
      assert.equal(onEdgeFuture.safeBunks, 0);
      assert.equal(onEdgeFuture.statusLabel, 'on edge 0 bunks');
      assert.equal(onEdgeFuture.statusType, 'warn');
    });
  });

  describe('Edge cases (Step 5)', () => {
    it('handles zero classes held (total 0)', () => {
      const zero = calculateCourseMetrics({ present: 0, absent: 0, leave: 0, scheduled: 40 });
      assert.equal(zero.held, 0);
      assert.equal(zero.pct, 0);
      assert.equal(zero.statusLabel, 'not marked yet');
      assert.equal(zero.statusType, 'none');
    });

    it('handles all zeros (zero scheduled, zero held)', () => {
      const allZero = calculateCourseMetrics({ present: 0, absent: 0, leave: 0, scheduled: 0 });
      assert.equal(allZero.held, 0);
      assert.equal(allZero.effectiveTotal, 0);
      assert.equal(allZero.pct, 0);
      assert.equal(allZero.statusLabel, 'not marked yet');
    });

    it('handles 100% attendance with classes remaining', () => {
      const full = calculateCourseMetrics({ present: 20, absent: 0, leave: 0, scheduled: 40, remaining: 20 });
      assert.equal(full.pct, 100);
      // 40 - ceil(0.75*40) = 40 - 30 = 10
      assert.equal(full.safeBunks, 10);
      assert.equal(full.statusLabel, 'safe bunks 10');
    });

    it('handles 100% attendance with zero classes remaining (completed)', () => {
      const completed = calculateCourseMetrics({ present: 40, absent: 0, leave: 0, scheduled: 40, remaining: 0 });
      assert.equal(completed.pct, 100);
      assert.equal(completed.statusLabel, 'completed');
      assert.equal(completed.statusType, 'ok');
    });

    it('handles configurable threshold (e.g. 80%)', () => {
      // 45 scheduled: ceil(0.80 * 45) = 36 min present, max absences = 9
      const c80 = calculateCourseMetrics({ present: 7, absent: 0, leave: 0, scheduled: 45 }, { threshold: 0.80 });
      assert.equal(c80.thresholdPct, 80);
      assert.equal(c80.safeBunks, 9);
      assert.equal(c80.statusLabel, 'safe bunks 9');

      // Feasibility at 80%
      const below80 = calculateCourseMetrics({ present: 10, absent: 10, leave: 0, scheduled: 30, remaining: 5 }, { threshold: 0.80 });
      // need: (0.80*20 - 10) / 0.20 = 6 / 0.20 = 30 classes needed > 5 remaining
      assert.equal(below80.statusLabel, 'cannot reach 80%');
    });
  });
});

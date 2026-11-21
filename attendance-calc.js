/**
 * Attendance & Bunk Projection Calculator for DCRUST
 *
 * Provides shared, mathematically consistent calculations for:
 * - Course attendance percentage and held classes (with configurable leave handling)
 * - Safe bunks across the entire semester (or "right now" if schedule unknown)
 * - Classes required to reach attendance threshold (e.g. 75%) with feasibility validation
 * - Reconciliation of timetable schedule discrepancies (held > scheduled)
 * - Consistent semester-level summary totals (held + remaining === total in sem)
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    var exp = factory();
    module.exports = exp;
    module.exports.default = exp;
    module.exports.calculateCourseMetrics = exp.calculateCourseMetrics;
    module.exports.calculateSemesterSummary = exp.calculateSemesterSummary;
    module.exports.DEFAULT_THRESHOLD = exp.DEFAULT_THRESHOLD;
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.AttendanceCalc = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_THRESHOLD = 0.75;

  /**
   * Calculates metrics, status, and safe bunks / recovery targets for a single course.
   *
   * @param {Object} course
   * @param {number} course.present - Classes attended
   * @param {number} course.absent - Classes missed
   * @param {number} [course.leave=0] - Classes on approved leave
   * @param {number} [course.scheduled=0] - Total scheduled classes in timetable
   * @param {number} [course.remaining] - Optional remaining classes (computed if omitted)
   * @param {Object} [options]
   * @param {number} [options.threshold=0.75] - Attendance threshold ratio (default: 0.75 for 75%)
   * @param {'evaluated'|'excused'|'credit'} [options.leaveRule='evaluated'] - How leaves are treated:
   *        - 'evaluated': leaves count as held classes not attended (present / (present + absent + leave))
   *        - 'excused': leaves are excused from attendance requirement (present / (present + absent))
   *        - 'credit': leaves count as attended ( (present + leave) / (present + absent + leave) )
   * @returns {Object} Calculated metrics
   */
  function calculateCourseMetrics(course, options) {
    course = course || {};
    options = options || {};

    var threshold = (typeof options.threshold === 'number' && options.threshold > 0 && options.threshold < 1)
      ? options.threshold
      : DEFAULT_THRESHOLD;
    var leaveRule = options.leaveRule || 'evaluated';

    var present = Math.max(0, parseInt(course.present, 10) || 0);
    var absent = Math.max(0, parseInt(course.absent, 10) || 0);
    var leave = Math.max(0, parseInt(course.leave, 10) || 0);
    var scheduled = Math.max(0, parseInt(course.scheduled, 10) || 0);

    // Total actual class sessions held
    var held = present + absent + leave;

    // Evaluated attendance counts based on leave rule
    var evaluatedHeld = held;
    var evaluatedAttended = present;
    var absencesTaken = absent;

    if (leaveRule === 'excused') {
      evaluatedHeld = present + absent;
      evaluatedAttended = present;
      absencesTaken = absent;
    } else if (leaveRule === 'credit') {
      evaluatedHeld = held;
      evaluatedAttended = present + leave;
      absencesTaken = absent;
    } else {
      // 'evaluated' (default): leaves are held classes without attendance credit
      evaluatedHeld = held;
      evaluatedAttended = present;
      absencesTaken = absent + leave;
    }

    var pct = evaluatedHeld > 0
      ? +((evaluatedAttended / evaluatedHeld) * 100).toFixed(2)
      : 0;

    // Schedule discrepancy check (Bug 1): teacher conducted more classes than timetable scheduled
    var hasScheduleDiscrepancy = scheduled > 0 && held > scheduled;
    var discrepancyMessage = hasScheduleDiscrepancy
      ? 'Held classes (' + held + ') exceed scheduled classes (' + scheduled + ') in portal timetable'
      : null;

    // Remaining classes calculation
    var remaining;
    if (typeof course.remaining === 'number' && !isNaN(course.remaining)) {
      remaining = Math.max(0, course.remaining);
    } else if (scheduled > 0) {
      remaining = Math.max(0, scheduled - held);
    } else {
      remaining = 0;
    }

    // If held classes already exceed or equal scheduled classes, no timetable classes remain
    if (scheduled > 0 && held >= scheduled && typeof course.remaining !== 'number') {
      remaining = 0;
    }

    // Effective course total for the semester (Bug 1 & 2 reconciliation)
    var effectiveTotal = scheduled > 0
      ? Math.max(scheduled, held + remaining)
      : held;

    var thresholdPct = Math.round(threshold * 100);
    var statusKey = '';
    var statusLabel = '';
    var statusType = 'none'; // 'none' | 'ok' | 'warn' | 'bad'
    var projMsg = '';
    var safeBunks = 0;
    var safeNow = 0;
    var requiredClasses = 0;
    var canReachThreshold = true;
    var maxPossiblePct = 100;

    if (held === 0) {
      // Edge case: zero classes held yet
      statusKey = 'not_marked';
      statusLabel = 'not marked yet';
      statusType = 'none';
      projMsg = scheduled > 0
        ? 'No classes held yet (<strong>' + scheduled + '</strong> scheduled).'
        : 'No classes held yet.';
      safeBunks = effectiveTotal > 0
        ? Math.max(0, effectiveTotal - Math.ceil(threshold * effectiveTotal))
        : 0;
      canReachThreshold = true;
    } else if (pct >= thresholdPct) {
      // Above or at attendance threshold
      // Safe bunks across semester: total - ceil(threshold * total) - absences
      var minPresentNeeded = Math.ceil(threshold * effectiveTotal);
      var maxAllowedAbsences = Math.max(0, effectiveTotal - minPresentNeeded);
      var rawSafeSemester = Math.max(0, maxAllowedAbsences - absencesTaken);

      // "Right now" safe bunks based solely on classes held so far
      var rawSafeNow = Math.floor((evaluatedAttended - threshold * evaluatedHeld) / threshold);
      safeNow = Math.max(0, rawSafeNow);

      if (scheduled > 0 && remaining === 0) {
        statusKey = 'completed';
        statusLabel = 'completed';
        statusType = 'ok';
        projMsg = 'Completed at <strong>' + pct.toFixed(2) + '%</strong>.';
        safeBunks = 0;
      } else if (scheduled > 0) {
        // Cap safe bunks at remaining classes (cannot bunk more classes than remain)
        safeBunks = Math.min(remaining, rawSafeSemester);
        if (safeBunks > 0) {
          statusKey = 'safe_bunks';
          statusLabel = 'safe bunks ' + safeBunks;
          statusType = 'ok';
          projMsg = 'Can bunk <strong>' + safeBunks + '</strong> more class' + (safeBunks === 1 ? '' : 'es')
            + ' this semester (attendance stays &ge; ' + thresholdPct + '%).';
        } else {
          statusKey = 'on_edge';
          statusLabel = 'on edge 0 bunks';
          statusType = 'warn';
          projMsg = 'On the edge (<strong>0</strong> safe bunks). Missing next class drops below ' + thresholdPct + '%.';
        }
      } else {
        // Semester total unknown: fallback to "right now" safe bunks (Bug 5)
        safeBunks = safeNow;
        if (safeNow > 0) {
          statusKey = 'safe_bunks_now';
          statusLabel = 'safe bunks ' + safeNow + ' (right now)';
          statusType = 'ok';
          projMsg = 'Safe bunks right now: <strong>' + safeNow + '</strong> (based on classes held so far, semester total unknown).';
        } else {
          statusKey = 'on_edge';
          statusLabel = 'on edge 0 bunks';
          statusType = 'warn';
          projMsg = 'On the edge (<strong>0</strong> safe bunks). Missing next class drops below ' + thresholdPct + '%.';
        }
      }
    } else {
      // Below threshold: calculate classes required to reach threshold
      // Formula: k >= ceil((threshold * evaluatedHeld - evaluatedAttended) / (1 - threshold))
      var rawNeed = Math.ceil((threshold * evaluatedHeld - evaluatedAttended) / (1 - threshold));
      requiredClasses = Math.max(0, rawNeed);

      // Feasibility check (Bug 4)
      if (scheduled > 0) {
        var maxPossibleAttended = evaluatedAttended + remaining;
        var maxPossibleHeld = evaluatedHeld + remaining;
        maxPossiblePct = maxPossibleHeld > 0
          ? +((maxPossibleAttended / maxPossibleHeld) * 100).toFixed(2)
          : 0;

        if (remaining === 0 || requiredClasses > remaining || maxPossiblePct < thresholdPct) {
          canReachThreshold = false;
          statusKey = 'cannot_reach';
          statusLabel = 'cannot reach ' + thresholdPct + '%';
          statusType = 'bad';
          if (remaining === 0) {
            projMsg = 'No classes left in semester. Final attendance: <strong>' + pct.toFixed(2)
              + '%</strong> (short of ' + thresholdPct + '%).';
          } else {
            projMsg = 'Needs <strong>' + requiredClasses + '</strong> class' + (requiredClasses === 1 ? '' : 'es')
              + ' to reach ' + thresholdPct + '%, but only <strong>' + remaining + '</strong> left'
              + ' (max possible: <strong>' + maxPossiblePct.toFixed(2) + '%</strong>).';
          }
        } else {
          canReachThreshold = true;
          statusKey = 'attend_classes';
          statusLabel = 'attend ' + requiredClasses + ' classes';
          statusType = 'bad';
          projMsg = 'Attend next <strong>' + requiredClasses + '</strong> class' + (requiredClasses === 1 ? '' : 'es')
            + ' to reach ' + thresholdPct + '%.';
        }
      } else {
        // Scheduled unknown: cannot verify against remaining classes
        canReachThreshold = true;
        statusKey = 'attend_classes';
        statusLabel = 'attend ' + requiredClasses + ' classes';
        statusType = 'bad';
        projMsg = 'Attend next <strong>' + requiredClasses + '</strong> class' + (requiredClasses === 1 ? '' : 'es')
          + ' to reach ' + thresholdPct + '%.';
      }
    }

    return {
      present: present,
      absent: absent,
      leave: leave,
      held: held,
      evaluatedHeld: evaluatedHeld,
      evaluatedAttended: evaluatedAttended,
      pct: pct,
      scheduled: scheduled,
      remaining: remaining,
      effectiveTotal: effectiveTotal,
      hasScheduleDiscrepancy: hasScheduleDiscrepancy,
      discrepancyMessage: discrepancyMessage,
      threshold: threshold,
      thresholdPct: thresholdPct,
      safeBunks: safeBunks,
      safeNow: safeNow,
      requiredClasses: requiredClasses,
      canReachThreshold: canReachThreshold,
      maxPossiblePct: maxPossiblePct,
      statusKey: statusKey,
      statusLabel: statusLabel,
      statusType: statusType,
      projMsg: projMsg,
    };
  }

  /**
   * Calculates overall attendance and summary metrics across a list of courses.
   * Guarantees that held + remaining === scheduled.
   *
   * @param {Array<Object>} courses
   * @param {Object} [options]
   * @returns {Object} Summary totals
   */
  function calculateSemesterSummary(courses, options) {
    courses = courses || [];
    options = options || {};

    var threshold = (typeof options.threshold === 'number' && options.threshold > 0 && options.threshold < 1)
      ? options.threshold
      : DEFAULT_THRESHOLD;
    var leaveRule = options.leaveRule || 'evaluated';

    var totalPresent = 0;
    var totalAbsent = 0;
    var totalLeave = 0;
    var totalHeld = 0;
    var totalRemaining = 0;
    var totalScheduled = 0;
    var hasAnyDiscrepancy = false;

    for (var i = 0; i < courses.length; i++) {
      var m = calculateCourseMetrics(courses[i], { threshold: threshold, leaveRule: leaveRule });
      totalPresent += m.present;
      totalAbsent += m.absent;
      totalLeave += m.leave;
      totalHeld += m.held;
      totalRemaining += m.remaining;
      totalScheduled += m.effectiveTotal;
      if (m.hasScheduleDiscrepancy) {
        hasAnyDiscrepancy = true;
      }
    }

    var evaluatedHeld = totalHeld;
    var evaluatedAttended = totalPresent;

    if (leaveRule === 'excused') {
      evaluatedHeld = totalPresent + totalAbsent;
      evaluatedAttended = totalPresent;
    } else if (leaveRule === 'credit') {
      evaluatedHeld = totalHeld;
      evaluatedAttended = totalPresent + totalLeave;
    }

    var overallPct = evaluatedHeld > 0
      ? +((evaluatedAttended / evaluatedHeld) * 100).toFixed(2)
      : 0;

    return {
      present: totalPresent,
      absent: totalAbsent,
      leave: totalLeave,
      held: totalHeld,
      total: totalHeld,
      remaining: totalRemaining,
      scheduled: totalScheduled,
      pct: overallPct,
      hasAnyDiscrepancy: hasAnyDiscrepancy,
      isConsistent: (totalHeld + totalRemaining === totalScheduled),
    };
  }

  return {
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
    calculateCourseMetrics: calculateCourseMetrics,
    calculateSemesterSummary: calculateSemesterSummary,
  };
});

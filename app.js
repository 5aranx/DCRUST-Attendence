(function () {
  'use strict';

  /* ============================================================
     Constants and state
     ============================================================ */

  var THEME_KEY = 'dcrustm_theme';
  var CREDS_KEY = 'dcrustm_saved_creds';
  var LEGACY_ATTENDANCE_KEY = 'dcrustm_saved_attendance';
  var THRESHOLD = 75;
  var ROUTES = ['dashboard', 'subjects', 'history'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTH_INDEX = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12
  };

  var state = {
    data: null,
    currentSem: null,
    view: 'dashboard',
    creds: null,
    busy: false,
    subjectSort: 'low',
    subjectFilter: 'all',
    calcKey: null,
    historySubject: 'all',
    historyStatus: 'all'
  };

  var lastModalFocus = null;
  var modalTimer = null;

  /* ============================================================
     Small helpers
     ============================================================ */

  function $(id) {
    return document.getElementById(id);
  }

  function all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function num(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function plural(count, one, many) {
    return count === 1 ? one : many;
  }

  function fmtPct(value) {
    return Number.isFinite(value) ? value.toFixed(2) : '0.00';
  }

  function totalRecords(courses) {
    var total = 0;
    for (var i = 0; i < courses.length; i++) {
      total += (courses[i].records || []).length;
    }
    return total;
  }

  /* ============================================================
     Theme
     ============================================================ */

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function syncThemeUi() {
    var theme = currentTheme();
    var toggle = $('theme-toggle');
    var meta = $('theme-color-meta');
    document.documentElement.style.colorScheme = theme;
    if (toggle) {
      toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
      toggle.setAttribute('title', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }
    if (meta) {
      meta.setAttribute('content', theme === 'dark' ? '#1c1a16' : '#f3e7cd');
    }
  }

  function applyTheme(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);
    syncThemeUi();
    if (persist) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* storage may be unavailable */ }
    }
  }

  function toggleTheme() {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
  }

  /* ============================================================
     Credentials (existing storage contract: dcrustm_saved_creds)
     ============================================================ */

  function readStoredCredentials() {
    try {
      var raw = localStorage.getItem(CREDS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && parsed.u && typeof parsed.p === 'string') {
        return { username: String(parsed.u), password: parsed.p };
      }
    } catch (e) { /* ignore malformed storage */ }
    return null;
  }

  function saveCredentials(username, password) {
    try {
      localStorage.setItem(CREDS_KEY, JSON.stringify({ u: username, p: password }));
    } catch (e) { /* storage may be unavailable */ }
  }

  function clearStoredCredentials() {
    try {
      localStorage.removeItem(CREDS_KEY);
      localStorage.removeItem(LEGACY_ATTENDANCE_KEY);
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
     Status, dates and formatting
     ============================================================ */

  function normalizeStatus(status) {
    var raw = String(status || '').trim().toUpperCase();
    if (raw === 'ABSENT' || raw === 'A') return 'Absent';
    if (raw === 'LEAVE' || raw === 'L') return 'Leave';
    return 'Present';
  }

  function makeDate(year, month, day) {
    if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;
    var date = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }

  function parseSessionDate(value) {
    var text = String(value == null ? '' : value).trim();
    if (!text) return null;
    var match;

    match = text.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
    if (match) return makeDate(+match[1], +match[2], +match[3]);

    match = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
    if (match) {
      var first = +match[1];
      var second = +match[2];
      var year = +match[3];
      if (year < 100) year += 2000;
      var day = first;
      var month = second;
      if (first <= 12 && second > 12) {
        day = second;
        month = first;
      }
      return makeDate(year, month, day);
    }

    match = text.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/);
    if (match) {
      var monthName = MONTH_INDEX[match[2].toLowerCase()];
      if (monthName) return makeDate(+match[3], monthName, +match[1]);
    }

    match = text.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (match) {
      var monthFromName = MONTH_INDEX[match[1].toLowerCase()];
      if (monthFromName) return makeDate(+match[3], monthFromName, +match[2]);
    }

    return null;
  }

  function dateParts(value) {
    var parsed = parseSessionDate(value);
    if (!parsed) {
      return { display: String(value == null ? '' : value).trim() || '—', weekday: '' };
    }
    return {
      display: pad2(parsed.getDate()) + ' ' + MONTHS[parsed.getMonth()] + ' ' + parsed.getFullYear(),
      weekday: WEEKDAYS[parsed.getDay()]
    };
  }

  function monthKey(value) {
    var parsed = parseSessionDate(value);
    if (!parsed) return 'unknown';
    return parsed.getFullYear() + '-' + pad2(parsed.getMonth() + 1);
  }

  function monthTitle(value) {
    var parsed = parseSessionDate(value);
    if (!parsed) return 'Recorded sessions';
    return MONTHS_LONG[parsed.getMonth()] + ' ' + parsed.getFullYear();
  }

  function cleanTime(value) {
    var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!text) return '—';
    return text.replace(/\s*-\s*/g, '–');
  }

  function formatDateTime(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '—';
    return pad2(date.getDate()) + ' ' + MONTHS[date.getMonth()] + ' ' + date.getFullYear()
      + ' · ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function semesterLabel(sem) {
    if (!sem || sem === 'all') return 'All semesters';
    return String(sem).replace(/^SEMESTER\s*-\s*(\d+)/i, 'Semester $1').replace(/^SEMESTER\s*(\d+)/i, 'Semester $1');
  }

  function statusTag(status) {
    var normalized = normalizeStatus(status);
    return '<span class="status-tag status-' + normalized.toLowerCase() + '">' + esc(normalized) + '</span>';
  }

  /* ============================================================
     Semester normalization (same fallbacks as the original client)
     ============================================================ */

  function getCourseSemester(course) {
    if (course.semester && typeof course.semester === 'string' && course.semester.trim()) {
      return course.semester.trim();
    }

    var dates = (course.records || []).map(function (record) { return record.date; }).filter(Boolean);
    if (dates.length > 0) {
      dates.sort();
      var mid = dates[Math.floor(dates.length / 2)];
      var ym = String(mid).substring(0, 7);
      if (ym >= '2025-01' && ym <= '2025-06') return 'SEMESTER - 4';
      if (ym >= '2025-07' && ym <= '2025-11') return 'SEMESTER - 5';
      if (ym >= '2025-12' && ym <= '2026-06') return 'SEMESTER - 6';
      if (ym >= '2026-07' && ym <= '2026-12') return 'SEMESTER - 7';
    }

    var code = String(course.code || '');
    var match = code.match(/([A-Z]+)(\d)(\d)?/i);
    if (match) {
      var first = parseInt(match[2], 10);
      var second = match[3] ? parseInt(match[3], 10) : 0;
      if (first === 4) return 'SEMESTER - 7';
      if (first === 3) return (second % 2 === 1) ? 'SEMESTER - 5' : 'SEMESTER - 6';
      if (first === 2) return 'SEMESTER - 4';
      if (first === 1) return 'SEMESTER - 1';
    }
    return '';
  }

  function getSemNum(semester) {
    var match = String(semester || '').match(/\d+/);
    return match ? parseInt(match[0], 10) : 0;
  }

  function formatSemOption(semester, courses) {
    if (semester === 'all') return 'All semesters';
    var clean = semesterLabel(semester);
    var session = '';
    for (var i = 0; i < courses.length; i++) {
      if (courses[i].semester === semester && courses[i].session) {
        session = courses[i].session;
        break;
      }
    }
    return session ? clean + ' (' + session + ')' : clean;
  }

  function findLastAttendedSemester(list, courses) {
    for (var i = 0; i < list.length; i++) {
      var semester = list[i];
      var semesterCourses = courses.filter(function (course) { return course.semester === semester; });
      var hasAttended = semesterCourses.some(function (course) {
        return (course.total > 0) || (course.present > 0);
      });
      if (hasAttended) return semester;
    }
    return list.length > 0 ? list[0] : 'all';
  }

  function normalizePayload(raw, preferredSemester) {
    var rawCourses = (raw && Array.isArray(raw.courses)) ? raw.courses : [];
    var courses = rawCourses.map(function (course, index) {
      var records = (course.records || []).map(function (record) {
        return {
          date: String(record && record.date != null ? record.date : '').trim(),
          time: String(record && record.time != null ? record.time : '').trim(),
          status: normalizeStatus(record && record.status),
          remarks: String(record && record.remarks != null ? record.remarks : '').trim()
        };
      });

      var normalized = {
        index: index,
        code: String(course.code || course.className || ''),
        baseCode: String(course.baseCode || ''),
        name: String(course.name || course.courseName || 'Untitled subject'),
        session: String(course.session || ''),
        teacher: String(course.teacher || ''),
        present: num(course.present),
        absent: num(course.absent),
        leave: num(course.leave),
        total: num(course.total),
        pct: num(course.pct),
        scheduled: num(course.scheduled),
        remaining: num(course.remaining),
        records: records,
        semester: ''
      };
      normalized.semester = getCourseSemester(normalized);
      return normalized;
    });

    var semList = [];
    var seen = {};
    for (var i = 0; i < courses.length; i++) {
      var semester = courses[i].semester;
      if (semester && !seen[semester]) {
        seen[semester] = true;
        semList.push(semester);
      }
    }
    semList.sort(function (a, b) { return getSemNum(b) - getSemNum(a); });

    var currentSem;
    if (preferredSemester && (preferredSemester === 'all' || semList.indexOf(preferredSemester) !== -1)) {
      currentSem = preferredSemester;
    } else {
      currentSem = findLastAttendedSemester(semList, courses);
    }

    var overall = raw && raw.overall ? raw.overall : {};
    return {
      username: String((raw && raw.username) || ''),
      fetchedAt: (raw && raw.fetchedAt) || new Date().toISOString(),
      overall: {
        present: num(overall.present),
        absent: num(overall.absent),
        leave: num(overall.leave),
        total: num(overall.total),
        pct: num(overall.pct),
        scheduled: num(overall.scheduled),
        remaining: num(overall.remaining)
      },
      courses: courses,
      semList: semList,
      currentSem: currentSem
    };
  }

  /* ============================================================
     Attendance calculations — preserved from the existing client
     ============================================================ */

  function activeCourses() {
    if (!state.data) return [];
    if (state.currentSem === 'all') return state.data.courses.slice();
    return state.data.courses.filter(function (course) {
      return course.semester === state.currentSem;
    });
  }

  function aggregateFor(courses) {
    var present = 0;
    var absent = 0;
    var leave = 0;
    var scheduled = 0;
    var remaining = 0;

    for (var i = 0; i < courses.length; i++) {
      var course = courses[i];
      present += num(course.present);
      absent += num(course.absent);
      leave += num(course.leave);
      scheduled += num(course.scheduled);
      remaining += num(course.remaining);
    }

    var total = present + absent;
    return {
      present: present,
      absent: absent,
      leave: leave,
      total: total,
      pct: total > 0 ? +((present / total) * 100).toFixed(2) : 0,
      scheduled: scheduled,
      remaining: remaining
    };
  }

  function overallProjection(aggregate) {
    var total = aggregate.total;
    var present = aggregate.present;
    var absent = aggregate.absent;
    var scheduled = aggregate.scheduled;
    var remaining = aggregate.remaining;
    var pct = total > 0 ? +((present / total) * 100).toFixed(2) : 0;
    var safeNow = 0;
    var recovery = 0;
    var status = 'none';
    var complete = false;

    if (total <= 0) {
      safeNow = scheduled > 0 ? Math.floor(0.25 * scheduled) : 0;
      status = 'none';
    } else if (pct >= THRESHOLD) {
      var rawSafe = Math.floor((present - 0.75 * total) / 0.75);
      safeNow = scheduled > 0 ? Math.min(remaining, Math.max(0, rawSafe)) : Math.max(0, rawSafe);
      if (scheduled > 0 && remaining === 0) {
        status = 'complete';
        complete = true;
        safeNow = 0;
      } else {
        status = safeNow > 0 ? 'safe' : 'edge';
      }
    } else {
      recovery = Math.max(0, Math.ceil(3 * absent - present));
      status = 'low';
      safeNow = 0;
    }

    return {
      present: present,
      absent: absent,
      leave: aggregate.leave,
      total: total,
      pct: pct,
      scheduled: scheduled,
      remaining: remaining,
      safeNow: safeNow,
      recovery: recovery,
      status: status,
      complete: complete,
      canRecover: scheduled > 0 ? recovery <= remaining : true
    };
  }

  function projectCourse(course) {
    var present = num(course.present);
    var absent = num(course.absent);
    var leave = num(course.leave);
    var total = num(course.total);
    var pct = num(course.pct);
    var scheduled = num(course.scheduled);
    var remaining = num(course.remaining);

    var projection = {
      present: present,
      absent: absent,
      leave: leave,
      total: total,
      pct: pct,
      scheduled: scheduled,
      remaining: remaining,
      safeNow: 0,
      safeSem: 0,
      rawNeed: 0,
      maxPossible: null,
      initialSafe: 0,
      status: 'none',
      canRecover: true
    };

    if (total <= 0) {
      projection.initialSafe = scheduled > 0 ? Math.floor(0.25 * scheduled) : 0;
      return projection;
    }

    if (pct >= THRESHOLD) {
      var rawSafeNow = Math.floor((present - 0.75 * total) / 0.75);
      var safeNow = scheduled > 0 ? Math.min(remaining, Math.max(0, rawSafeNow)) : Math.max(0, rawSafeNow);
      var rawSafeSem = Math.floor(present + 0.25 * remaining - 0.75 * total);
      var safeSem = scheduled > 0 ? Math.max(safeNow, Math.min(remaining, Math.max(0, rawSafeSem))) : safeNow;

      projection.safeNow = safeNow;
      projection.safeSem = safeSem;

      if (scheduled > 0 && remaining === 0) {
        projection.status = 'complete';
      } else if (safeNow > 0) {
        projection.status = 'safe';
      } else {
        projection.status = 'edge';
      }
      return projection;
    }

    projection.rawNeed = Math.max(0, Math.ceil(3 * absent - present));

    if (scheduled > 0 && remaining === 0) {
      projection.status = 'short';
      return projection;
    }

    if (remaining > 0) {
      projection.maxPossible = +(((present + remaining) / (total + remaining)) * 100).toFixed(1);
      if (projection.rawNeed > remaining) {
        projection.status = 'critical';
        projection.canRecover = false;
        return projection;
      }
    }

    projection.status = 'low';
    return projection;
  }

  function projectionStatusClass(status) {
    if (status === 'safe' || status === 'complete') return 'is-good';
    if (status === 'edge') return 'is-edge';
    if (status === 'low' || status === 'critical' || status === 'short') return 'is-low';
    return 'is-quiet';
  }

  function projectionStatusLabel(status) {
    if (status === 'safe') return 'Safe';
    if (status === 'edge') return 'On the edge';
    if (status === 'complete') return 'Complete';
    if (status === 'critical') return 'Out of reach';
    if (status === 'short') return 'Short';
    if (status === 'low') return 'Below 75%';
    return 'Not marked';
  }

  function projectionRemedy(projection) {
    if (projection.status === 'none') {
      return {
        value: projection.scheduled > 0 ? String(projection.initialSafe) : '—',
        note: projection.scheduled > 0 ? 'bunks safe' : 'no sessions',
        cls: 'is-quiet'
      };
    }
    if (projection.status === 'complete') {
      return { value: '—', note: 'final', cls: 'is-quiet' };
    }
    if (projection.status === 'safe') {
      return { value: String(projection.safeNow), note: 'bunks left', cls: 'is-good' };
    }
    if (projection.status === 'edge') {
      return { value: '0', note: 'bunks left', cls: 'is-edge' };
    }
    if (projection.status === 'critical') {
      return { value: '+' + projection.rawNeed, note: 'out of reach', cls: 'is-low' };
    }
    if (projection.status === 'short') {
      return { value: '+' + projection.rawNeed, note: 'not met', cls: 'is-low' };
    }
    return { value: '+' + projection.rawNeed, note: 'to recover', cls: 'is-low' };
  }

  function projectionText(projection) {
    var p = projection;

    if (p.status === 'none') {
      if (p.scheduled > 0) {
        return 'No sessions have been held yet. <strong>' + p.scheduled + '</strong> classes are scheduled this semester; up to <strong>' + p.initialSafe + '</strong> can be missed while staying at or above 75%.';
      }
      return 'No sessions have been marked on the portal for this subject yet.';
    }

    if (p.status === 'complete') {
      return 'The semester’s scheduled classes are complete. Final attendance is <strong>' + fmtPct(p.pct) + '%</strong>.';
    }

    if (p.status === 'short') {
      return 'The semester is complete at <strong>' + fmtPct(p.pct) + '%</strong> — <strong>' + p.rawNeed + '</strong> classes short of the 75% requirement.';
    }

    if (p.pct >= THRESHOLD) {
      if (p.safeNow > 0) {
        if (p.scheduled > 0 && p.safeSem === p.remaining && p.remaining > 0) {
          var minFinal = +((p.present / (p.total + p.remaining)) * 100).toFixed(2);
          return 'You have <strong>' + p.remaining + '</strong> classes left. You can miss all of them and still finish at <strong>' + minFinal.toFixed(2) + '%</strong>.';
        }
        if (p.scheduled > 0 && p.safeSem > p.safeNow) {
          return 'You can miss <strong>' + p.safeNow + '</strong> consecutively right now, or up to <strong>' + p.safeSem + '</strong> of the <strong>' + p.remaining + '</strong> remaining classes this semester.';
        }
        return 'You can miss <strong>' + p.safeNow + '</strong> consecutive ' + plural(p.safeNow, 'class', 'classes') + ' and stay at or above 75%.';
      }
      return 'You are exactly on the 75% line. Missing the next class will take you below it.';
    }

    if (p.remaining > 0) {
      if (!p.canRecover) {
        return 'Even attending all <strong>' + p.remaining + '</strong> remaining classes, the final attendance would reach <strong>' + p.maxPossible.toFixed(1) + '%</strong> — below the 75% requirement.';
      }
      return 'Attend <strong>' + p.rawNeed + '</strong> consecutive ' + plural(p.rawNeed, 'class', 'classes') + ' to return to 75%. Attending all <strong>' + p.remaining + '</strong> remaining classes would finish at <strong>' + p.maxPossible.toFixed(1) + '%</strong>.';
    }

    return 'You need <strong>' + p.rawNeed + '</strong> more ' + plural(p.rawNeed, 'class', 'classes') + ' to reach 75%, but no further classes are scheduled.';
  }

  function overallNote(projection) {
    if (projection.status === 'none') {
      return projection.scheduled > 0
        ? 'No sessions held yet; ' + projection.scheduled + ' scheduled.'
        : 'No sessions on the register yet.';
    }
    if (projection.status === 'complete') return 'Semester complete at ' + fmtPct(projection.pct) + '%.';
    if (projection.status === 'edge') {
      if (projection.pct > THRESHOLD) {
        return fmtPct(projection.pct - THRESHOLD) + ' points above, but no bunks left.';
      }
      return 'Exactly on the 75% line.';
    }
    if (projection.status === 'low') {
      return fmtPct(THRESHOLD - projection.pct) + ' points below the requirement.';
    }
    return fmtPct(projection.pct - THRESHOLD) + ' points above the requirement.';
  }

  function overallBadge(projection) {
    if (projection.status === 'none') return 'No sessions';
    if (projection.status === 'complete') return 'Semester complete';
    if (projection.status === 'edge') {
      return projection.pct > THRESHOLD ? 'No bunks left' : 'On the threshold';
    }
    if (projection.status === 'low') return 'Below threshold';
    return 'Above threshold';
  }

  /* ============================================================
     Worker communication
     ============================================================ */

  function workerUrl() {
    var base = window.DCRUSTM_WORKER;
    if (!base || typeof base !== 'string' || base.indexOf('your-worker') !== -1) return '';
    return base.replace(/\/+$/, '');
  }

  function ApiError(message, status) {
    this.name = 'ApiError';
    this.message = message;
    this.status = status || 0;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  async function requestAttendance(username, password) {
    var base = workerUrl();
    if (!base) {
      throw new ApiError('The attendance service is not configured. Set window.DCRUSTM_WORKER in config.js.');
    }

    var response;
    try {
      response = await fetch(base + '/attendance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      });
    } catch (error) {
      throw new ApiError('Could not reach the attendance service. Check your connection and try again.');
    }

    var payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      var message = payload && payload.error
        ? String(payload.error)
        : 'The attendance service returned an error (' + response.status + ').';
      throw new ApiError(message, response.status);
    }

    if (!payload || !Array.isArray(payload.courses)) {
      throw new ApiError('The attendance service returned an unexpected response. Please try again.');
    }

    return payload;
  }

  /* ============================================================
     Login and loading state
     ============================================================ */

  function setLoginStatus(message) {
    var status = $('login-status');
    if (status) status.textContent = message || '';
  }

  function showLoginError(message) {
    var box = $('login-error');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
  }

  function clearLoginError() {
    showLoginError('');
  }

  function setFieldError(fieldId, message) {
    var input = $(fieldId);
    var error = $(fieldId + '-error');
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    if (error) {
      error.textContent = message || '';
      error.hidden = !message;
    }
  }

  function clearFieldErrors() {
    setFieldError('u', '');
    setFieldError('p', '');
  }

  function setLoginLoading(loading) {
    var button = $('go');
    var spinner = $('go-spinner');
    var label = $('go-label');
    var form = $('login-form');
    if (!button || !spinner || !label || !form) return;

    button.disabled = loading;
    spinner.hidden = !loading;
    label.textContent = loading ? 'Reading register…' : 'Check attendance';
    form.setAttribute('aria-busy', loading ? 'true' : 'false');
    if (loading) {
      setLoginStatus('Contacting Samarth. This usually takes a few seconds.');
    } else {
      setLoginStatus('');
    }
  }

  function setRefreshLoading(loading) {
    var refresh = $('refresh-btn');
    var menuRefresh = $('menu-refresh');
    var bar = $('register-bar');

    if (refresh) {
      refresh.disabled = loading;
      refresh.textContent = loading ? 'Refreshing…' : 'Refresh';
    }
    if (menuRefresh) {
      menuRefresh.disabled = loading;
      menuRefresh.textContent = loading ? 'Refreshing attendance…' : 'Refresh attendance';
    }
    if (bar) bar.setAttribute('aria-busy', loading ? 'true' : 'false');
  }

  function applyRememberPreference(username, password) {
    var remember = $('remember');
    if (remember && remember.checked) saveCredentials(username, password);
    else clearStoredCredentials();
  }

  async function loadAttendance(username, password, mode) {
    if (state.busy) return;
    state.busy = true;

    var isRefresh = mode === 'refresh';
    clearLoginError();

    if (isRefresh) setRefreshLoading(true);
    else setLoginLoading(true);

    try {
      var raw = await requestAttendance(username, password);
      var preferred = isRefresh ? state.currentSem : null;
      var normalized = normalizePayload(raw, preferred);

      state.data = normalized;
      state.currentSem = normalized.currentSem;
      state.creds = { username: username, password: password };

      applyRememberPreference(username, password);

      if (!isRefresh) {
        state.view = routeFromHash();
        if (state.view === 'login') state.view = 'dashboard';
      }

      renderChrome();
      renderDataViews();
      showView(state.view);

      if (isRefresh) {
        showToast('Attendance refreshed.', 'success');
      }
    } catch (error) {
      var message = (error && error.message) ? error.message : 'Could not read your attendance. Please try again.';
      if (isRefresh) {
        showToast(message, 'error');
      } else {
        showLoginError(message);
        if (error && error.status === 401) {
          var passwordField = $('p');
          if (passwordField) passwordField.focus();
        }
      }
    } finally {
      state.busy = false;
      setLoginLoading(false);
      setRefreshLoading(false);
    }
  }

  function handleLoginSubmit(event) {
    event.preventDefault();
    if (state.busy) return;

    clearFieldErrors();
    clearLoginError();

    var usernameField = $('u');
    var passwordField = $('p');
    var username = usernameField ? usernameField.value.trim() : '';
    var password = passwordField ? passwordField.value : '';

    if (!username) {
      setFieldError('u', 'Enter your roll number.');
      usernameField.focus();
      return;
    }

    if (!/^[0-9]{8,16}$/.test(username)) {
      setFieldError('u', 'Roll numbers are 8–16 digits with no spaces.');
      usernameField.focus();
      return;
    }

    if (!password) {
      setFieldError('p', 'Enter your Samarth password.');
      passwordField.focus();
      return;
    }

    if (password.length < 4 || password.length > 64) {
      setFieldError('p', 'Passwords are 4–64 characters.');
      passwordField.focus();
      return;
    }

    loadAttendance(username, password, 'login');
  }

  function handleRefresh() {
    if (state.busy) return;
    if (!state.creds) {
      showToast('Sign in again before refreshing.', 'error');
      return;
    }
    loadAttendance(state.creds.username, state.creds.password, 'refresh');
  }

  function signOut() {
    state.data = null;
    state.currentSem = null;
    state.creds = null;
    state.calcKey = null;
    state.historySubject = 'all';
    state.historyStatus = 'all';

    clearStoredCredentials();
    closeAccountMenu(false);

    var usernameField = $('u');
    var passwordField = $('p');
    if (usernameField) usernameField.value = '';
    if (passwordField) {
      passwordField.value = '';
      passwordField.type = 'password';
      passwordField.removeAttribute('aria-invalid');
    }
    var toggle = $('pw-toggle');
    if (toggle) {
      toggle.classList.remove('is-visible');
      toggle.setAttribute('aria-label', 'Show password');
    }
    var remember = $('remember');
    if (remember) remember.checked = true;

    clearFieldErrors();
    clearLoginError();
    setLoginStatus('');

    if ($('main-nav')) $('main-nav').hidden = true;
    if ($('register-bar')) $('register-bar').hidden = true;
    if ($('account')) $('account').hidden = true;

    state.view = 'dashboard';
    try { history.replaceState(null, '', '#/dashboard'); } catch (e) { /* ignore */ }
    showView('login');

    if (usernameField) usernameField.focus();
  }

  /* ============================================================
     Chrome: register bar, semester selector, account
     ============================================================ */

  function routeFromHash() {
    var route = String(location.hash || '').replace(/^#\/?/, '').toLowerCase();
    return ROUTES.indexOf(route) !== -1 ? route : 'dashboard';
  }

  function updateChromeText() {
    if (!state.data) return;
    var courses = activeCourses();
    var sessions = totalRecords(courses);
    var scopeCount = $('scope-count');
    var syncNote = $('sync-note');
    var accountMeta = $('account-meta');

    if (scopeCount) {
      scopeCount.textContent = courses.length + ' ' + plural(courses.length, 'subject', 'subjects');
    }
    if (syncNote) {
      syncNote.textContent = 'Last read ' + formatDateTime(state.data.fetchedAt) + ' · ' + sessions + ' ' + plural(sessions, 'session', 'sessions');
    }
    if (accountMeta) {
      accountMeta.textContent = semesterLabel(state.currentSem) + ' · ' + courses.length + ' ' + plural(courses.length, 'subject', 'subjects');
    }
  }

  function renderChrome() {
    if (!state.data) return;

    var select = $('semester-select');
    if (select) {
      var options = '';
      for (var i = 0; i < state.data.semList.length; i++) {
        var semester = state.data.semList[i];
        options += '<option value="' + esc(semester) + '">'
          + esc(formatSemOption(semester, state.data.courses))
          + '</option>';
      }
      if (state.data.semList.length > 1) {
        options += '<option value="all">All semesters ('
          + state.data.courses.length + ' subjects)</option>';
      } else if (state.currentSem === 'all') {
        options += '<option value="all">All semesters</option>';
      }
      if (!options) options = '<option value="all">All semesters</option>';
      select.innerHTML = options;
      select.value = state.currentSem || 'all';
    }

    var roll = state.data.username || 'Account';
    if ($('account-roll')) $('account-roll').textContent = roll;
    if ($('account-roll-full')) $('account-roll-full').textContent = roll;

    if ($('main-nav')) $('main-nav').hidden = false;
    if ($('register-bar')) $('register-bar').hidden = false;
    if ($('account')) $('account').hidden = false;

    updateChromeText();
  }

  function handleSemesterChange(value) {
    state.currentSem = value;
    state.calcKey = null;
    if (state.historySubject !== 'all') {
      var stillThere = activeCourses().some(function (course) {
        return String(course.index) === String(state.historySubject);
      });
      if (!stillThere) state.historySubject = 'all';
    }
    updateChromeText();
    renderDataViews();
    showView(state.view);
  }

  /* ============================================================
     Dashboard
     ============================================================ */

  function scopeDescription(courses) {
    var sessions = [];
    for (var i = 0; i < courses.length; i++) {
      var session = courses[i].session;
      if (session && sessions.indexOf(session) === -1) sessions.push(session);
    }
    return {
      semester: semesterLabel(state.currentSem),
      sessions: sessions.join(' · '),
      courses: courses.length,
      records: totalRecords(courses)
    };
  }

  function overviewCopy(projection) {
    if (projection.status === 'none') {
      if (projection.scheduled > 0) {
        return 'No sessions have been held yet. Attendance is calculated from present and absent sessions; leave is recorded separately. You could miss up to <strong>' + projection.safeNow + '</strong> of the <strong>' + projection.scheduled + '</strong> scheduled classes and stay at 75%.';
      }
      return 'No sessions are on the register yet. Once Samarth marks a class, your percentage and safe bunks will appear here.';
    }
    if (projection.status === 'complete') {
      return 'The semester’s scheduled classes are complete. Your final attendance is <strong>' + fmtPct(projection.pct) + '%</strong>.';
    }
    if (projection.status === 'edge') {
      if (projection.pct > THRESHOLD) {
        return 'You are <strong>' + fmtPct(projection.pct - THRESHOLD) + ' points</strong> above the requirement, but there is no full-class buffer left. Missing the next class will take you below 75%.';
      }
      return 'You are exactly on the 75% line. Missing the next class will put you below the requirement.';
    }
    if (projection.status === 'low') {
      if (!projection.canRecover) {
        return 'You are <strong>' + fmtPct(THRESHOLD - projection.pct) + ' points</strong> below 75%. Even attending every remaining class would finish below the requirement.';
      }
      return 'You are <strong>' + fmtPct(THRESHOLD - projection.pct) + ' points</strong> below 75%. Attend <strong>' + projection.recovery + '</strong> consecutive ' + plural(projection.recovery, 'class', 'classes') + ' to return to the line.';
    }
    return 'You are <strong>' + fmtPct(projection.pct - THRESHOLD) + ' points</strong> above the requirement. You can miss <strong>' + projection.safeNow + '</strong> consecutive ' + plural(projection.safeNow, 'class', 'classes') + ' before crossing 75%.';
  }

  function statStripHtml(aggregate, projection) {
    var pctClass = projectionStatusClass(projection.status);
    var pctValue = projection.total > 0
      ? fmtPct(projection.pct) + '<span class="stat-unit">%</span>'
      : '—';

    var safeValue;
    var safeNote;
    var safeClass;

    if (projection.status === 'low') {
      safeValue = '0';
      safeNote = 'recover ' + projection.recovery + ' ' + plural(projection.recovery, 'class', 'classes');
      safeClass = 'is-low';
    } else if (projection.status === 'none') {
      safeValue = projection.scheduled > 0 ? String(projection.safeNow) : '—';
      safeNote = projection.scheduled > 0 ? 'from scheduled classes' : 'no classes scheduled';
      safeClass = 'is-quiet';
    } else if (projection.status === 'edge') {
      safeValue = '0';
      safeNote = 'attend the next class';
      safeClass = 'is-edge';
    } else if (projection.status === 'complete') {
      safeValue = '—';
      safeNote = 'semester complete';
      safeClass = 'is-quiet';
    } else {
      safeValue = String(projection.safeNow);
      safeNote = 'consecutive bunks';
      safeClass = 'is-good';
    }

    var conductedNote = projection.scheduled > 0
      ? projection.scheduled + ' scheduled this semester'
      : 'present + absent';
    var attendedNote = projection.leave > 0
      ? projection.leave + ' ' + plural(projection.leave, 'leave', 'leaves') + ' recorded'
      : 'sessions marked present';

    return ''
      + '<div class="stats-strip">'
      + '  <div class="stat-cell">'
      + '    <span class="stat-label">Overall attendance</span>'
      + '    <strong class="stat-value ' + pctClass + '">' + pctValue + '</strong>'
      + '    <span class="stat-note ' + (projection.status === 'low' ? 'is-low' : '') + '">' + esc(overallNote(projection)) + '</span>'
      + '  </div>'
      + '  <div class="stat-cell">'
      + '    <span class="stat-label">Classes conducted</span>'
      + '    <strong class="stat-value">' + projection.total + '</strong>'
      + '    <span class="stat-note">' + esc(conductedNote) + '</span>'
      + '  </div>'
      + '  <div class="stat-cell">'
      + '    <span class="stat-label">Classes attended</span>'
      + '    <strong class="stat-value">' + projection.present + '</strong>'
      + '    <span class="stat-note">' + esc(attendedNote) + '</span>'
      + '  </div>'
      + '  <div class="stat-cell">'
      + '    <span class="stat-label">Safe bunks left</span>'
      + '    <strong class="stat-value ' + safeClass + '">' + safeValue + '</strong>'
      + '    <span class="stat-note ' + (safeClass === 'is-low' ? 'is-low' : safeClass === 'is-good' ? 'is-good' : '') + '">' + esc(safeNote) + '</span>'
      + '  </div>'
      + '</div>';
  }

  function overviewHtml(aggregate, projection) {
    var pctClass = projectionStatusClass(projection.status);
    var pctValue = projection.total > 0
      ? fmtPct(projection.pct) + '<span class="pct-mark">%</span>'
      : '—';
    var width = projection.total > 0 ? clamp(projection.pct, 0, 100) : 0;
    var safeDisplay = projection.status === 'low' || projection.status === 'edge' ? '0' : String(projection.safeNow);
    var recoveryDisplay = projection.status === 'low' ? String(projection.recovery) : '—';

    return ''
      + '<section class="section">'
      + '  <div class="section-head">'
      + '    <div class="section-title-wrap">'
      + '      <p class="mono-label">01 / Standing</p>'
      + '      <h2>Attendance overview</h2>'
      + '    </div>'
      + '    <p class="section-note">Present ÷ (present + absent). Leave is logged separately and excluded from the percentage.</p>'
      + '  </div>'
      + '  <div class="overview-grid">'
      + '    <div>'
      + '      <div class="standing-figure">'
      + '        <span class="standing-pct ' + pctClass + '">' + pctValue + '</span>'
      + '        <span class="standing-badge ' + pctClass + '">' + esc(overallBadge(projection)) + '</span>'
      + '      </div>'
      + '      <div class="measure" role="img" aria-label="Overall attendance ' + fmtPct(projection.pct) + ' percent; requirement is 75 percent.">'
      + '        <div class="measure-track">'
      + '          <div class="measure-fill ' + pctClass + '" style="--pct:' + width + '%"></div>'
      + '          <span class="measure-threshold" aria-hidden="true"></span>'
      + '        </div>'
      + '        <div class="measure-scale"><span>0%</span><span class="scale-threshold">75% requirement</span><span>100%</span></div>'
      + '      </div>'
      + '      <dl class="standing-facts">'
      + '        <div class="fact"><dt class="fact-label">Present</dt><dd class="fact-value">' + projection.present + '</dd></div>'
      + '        <div class="fact"><dt class="fact-label">Absent</dt><dd class="fact-value">' + projection.absent + '</dd></div>'
      + '        <div class="fact"><dt class="fact-label">Leave</dt><dd class="fact-value">' + projection.leave + '</dd></div>'
      + '        <div class="fact"><dt class="fact-label">Remaining</dt><dd class="fact-value">' + projection.remaining + '</dd></div>'
      + '      </dl>'
      + '    </div>'
      + '    <aside class="rule-note">'
      + '      <p class="mono-label">The 75% rule</p>'
      + '      <p class="rule-copy">' + overviewCopy(projection) + '</p>'
      + '      <dl class="rule-list">'
      + '        <div class="rule-row"><dt>Safe bunks now</dt><dd class="' + (projection.safeNow > 0 ? 'is-good' : '') + '">' + safeDisplay + '</dd></div>'
      + '        <div class="rule-row"><dt>Classes to recover</dt><dd class="' + (projection.recovery > 0 ? 'is-low' : '') + '">' + recoveryDisplay + '</dd></div>'
      + '        <div class="rule-row"><dt>Classes left this semester</dt><dd>' + (projection.scheduled > 0 ? projection.remaining : '—') + '</dd></div>'
      + '      </dl>'
      + '    </aside>'
      + '  </div>'
      + '</section>';
  }

  function subjectDetailHtml(course, prefix) {
    var projection = projectCourse(course);
    var records = course.records || [];
    var counts = { all: records.length, Present: 0, Absent: 0, Leave: 0 };
    var lines = '';

    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      counts[record.status] = (counts[record.status] || 0) + 1;
      var parts = dateParts(record.date);
      lines += '<div class="session-line" data-status="' + esc(record.status) + '">'
        + '<span class="session-date">' + esc(parts.display)
        + (parts.weekday ? '<span class="session-day">' + esc(parts.weekday) + '</span>' : '')
        + '</span>'
        + '<span class="session-time">' + esc(cleanTime(record.time)) + '</span>'
        + '<span class="session-status">' + statusTag(record.status) + '</span>'
        + '</div>';
    }

    var filter = '';
    if (records.length > 0) {
      filter = '<div class="segmented" role="group" aria-label="Filter sessions for ' + esc(course.name) + '">'
        + '<button type="button" class="filter-btn" data-detail-filter="all" aria-pressed="true">All <span class="filter-count">' + counts.all + '</span></button>'
        + '<button type="button" class="filter-btn" data-detail-filter="Present" aria-pressed="false">Present <span class="filter-count">' + counts.Present + '</span></button>'
        + '<button type="button" class="filter-btn" data-detail-filter="Absent" aria-pressed="false">Absent <span class="filter-count">' + counts.Absent + '</span></button>'
        + (counts.Leave > 0 ? '<button type="button" class="filter-btn" data-detail-filter="Leave" aria-pressed="false">Leave <span class="filter-count">' + counts.Leave + '</span></button>' : '')
        + '</div>';
    }

    var recordsHtml = records.length > 0
      ? '<div class="detail-records">' + lines + '</div><p class="filter-empty" hidden>No sessions match this filter.</p>'
      : '<div class="filter-empty">No attendance records have been marked on the portal for this subject yet.</div>';

    var detailId = 'subject-detail-' + prefix + '-' + course.index;
    var code = course.baseCode || course.code || '';

    return '<div class="subject-detail" id="' + detailId + '" hidden>'
      + '  <div class="detail-grid">'
      + '    <div class="detail-log">'
      + '      <div class="detail-head">'
      + '        <div>'
      + '          <h3 class="detail-title">Session log</h3>'
      + '          <p class="detail-sub">' + esc(code || 'Uncoded subject') + (course.teacher ? ' · ' + esc(course.teacher) : '') + '</p>'
      + '        </div>'
      + filter
      + '      </div>'
      + recordsHtml
      + '    </div>'
      + '    <aside class="detail-note">'
      + '      <p class="mono-label">Projection</p>'
      + '      <p class="projection">' + projectionText(projection) + '</p>'
      + '      <dl class="mini-facts">'
      + '        <div class="mini-fact"><dt>Teacher</dt><dd>' + esc(course.teacher || '—') + '</dd></div>'
      + '        <div class="mini-fact"><dt>Scheduled</dt><dd>' + (projection.scheduled > 0 ? projection.scheduled : '—') + '</dd></div>'
      + '        <div class="mini-fact"><dt>Remaining</dt><dd>' + (projection.scheduled > 0 ? projection.remaining : '—') + '</dd></div>'
      + '        <div class="mini-fact"><dt>Leave</dt><dd>' + projection.leave + '</dd></div>'
      + '      </dl>'
      + '    </aside>'
      + '  </div>'
      + '</div>';
  }

  function subjectRowHtml(course, prefix, showSemester) {
    var projection = projectCourse(course);
    var statusClass = projectionStatusClass(projection.status);
    var remedy = projectionRemedy(projection);
    var pct = projection.total > 0 ? fmtPct(projection.pct) + '%' : '—';
    var width = projection.total > 0 ? clamp(projection.pct, 0, 100) : 0;
    var code = course.baseCode || course.code || '';
    var attended = projection.total > 0
      ? projection.present + ' <span class="of">/ ' + projection.total + '</span>'
      : '—';
    var detailId = 'subject-detail-' + prefix + '-' + course.index;

    return '<article class="subject">'
      + '<button type="button" class="subject-line" data-subject-toggle aria-expanded="false" aria-controls="' + detailId + '">'
      + '  <span class="subject-main">'
      + '    <span class="subject-name">' + esc(course.name) + '</span>'
      + '    <span class="subject-meta">'
      + (code ? '<span class="subject-code">' + esc(code) + '</span>' : '')
      + (showSemester && course.semester ? '<span class="subject-semester">' + esc(semesterLabel(course.semester)) + '</span>' : '')
      + (course.teacher ? '<span class="subject-teacher" title="' + esc(course.teacher) + '">' + esc(course.teacher) + '</span>' : '')
      + '    </span>'
      + '  </span>'
      + '  <span class="subject-attended"><span class="cell-label">Attended</span><span class="cell-value">' + attended + '</span></span>'
      + '  <span class="subject-standing">'
      + '    <span class="subject-pct ' + statusClass + '">' + pct + '</span>'
      + '    <span class="bar"><span class="bar-fill ' + statusClass + '" style="--pct:' + width + '%"></span><span class="bar-threshold" aria-hidden="true"></span></span>'
      + '  </span>'
      + '  <span class="subject-status ' + statusClass + '"><span class="status-dot"></span>' + esc(projectionStatusLabel(projection.status)) + '</span>'
      + '  <span class="subject-remedy"><span class="remedy-value ' + remedy.cls + '">' + esc(remedy.value) + '</span><span class="remedy-note">' + esc(remedy.note) + '</span></span>'
      + '  <span class="chevron" aria-hidden="true">&#9662;</span>'
      + '</button>'
      + subjectDetailHtml(course, prefix)
      + '</article>';
  }

  function subjectListHtml(courses, prefix, showSemester) {
    if (!courses.length) {
      return '<div class="empty-state">'
        + '<span class="empty-mark" aria-hidden="true">—</span>'
        + '<h3 class="empty-title">No subjects on this register</h3>'
        + '<p class="empty-copy">Samarth has not returned any enrolled subjects for this semester. Try refreshing the register.</p>'
        + '</div>';
    }

    var rows = '';
    for (var i = 0; i < courses.length; i++) {
      rows += subjectRowHtml(courses[i], prefix, showSemester);
    }

    return '<div class="subject-head" aria-hidden="true">'
      + '<span>Subject</span><span>Attended</span><span>Standing</span><span>Status</span><span>Remedy</span><span></span>'
      + '</div>'
      + '<div class="subject-list">' + rows + '</div>';
  }

  function handleSubjectClick(event, container) {
    var filterButton = event.target.closest('[data-subject-filter]');
    if (filterButton && container.contains(filterButton)) {
      state.subjectFilter = filterButton.getAttribute('data-subject-filter');
      all('[data-subject-filter]', container).forEach(function (button) {
        button.setAttribute('aria-pressed', button === filterButton ? 'true' : 'false');
      });
      updateSubjectList();
      return;
    }

    var detailButton = event.target.closest('[data-detail-filter]');
    if (detailButton) {
      var detail = detailButton.closest('.subject-detail');
      if (!detail) return;
      var filter = detailButton.getAttribute('data-detail-filter');
      all('[data-detail-filter]', detail).forEach(function (button) {
        button.setAttribute('aria-pressed', button === detailButton ? 'true' : 'false');
      });
      var visible = 0;
      all('.session-line', detail).forEach(function (row) {
        var show = filter === 'all' || row.getAttribute('data-status') === filter;
        row.hidden = !show;
        if (show) visible++;
      });
      var empty = detail.querySelector('.filter-empty');
      if (empty) empty.hidden = visible !== 0;
      return;
    }

    var line = event.target.closest('.subject-line');
    if (!line || !container.contains(line)) return;
    var isOpen = line.getAttribute('aria-expanded') === 'true';
    var panel = $(line.getAttribute('aria-controls'));
    if (!panel) return;
    line.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    panel.hidden = isOpen;
  }

  function renderCalculatorHtml(courses) {
    if (!courses.length) return '';
    var selected = null;
    if (state.calcKey) {
      for (var i = 0; i < courses.length; i++) {
        if (courses[i].code === state.calcKey) { selected = courses[i]; break; }
      }
    }
    if (!selected) {
      selected = courses[0];
      state.calcKey = selected.code;
    }

    var options = '';
    for (var j = 0; j < courses.length; j++) {
      var course = courses[j];
      var label = course.name + (course.baseCode || course.code ? ' · ' + (course.baseCode || course.code) : '');
      options += '<option value="' + esc(course.code) + '"' + (course.code === selected.code ? ' selected' : '') + '>' + esc(label) + '</option>';
    }

    return '<section class="section">'
      + '  <div class="section-head">'
      + '    <div class="section-title-wrap">'
      + '      <p class="mono-label">03 / Calculator</p>'
      + '      <h2>Bunk arithmetic</h2>'
      + '    </div>'
      + '    <p class="section-note">The same 75% rule, applied to one subject at a time. No projection changes your recorded attendance.</p>'
      + '  </div>'
      + '  <div class="calculator-grid">'
      + '    <div class="calc-intro">'
      + '      <p>Choose a subject to read its margin. “Safe to miss” is the number of consecutive classes that can be skipped before the percentage drops below 75.</p>'
      + '      <div class="calc-field">'
      + '        <label for="calc-subject">Subject</label>'
      + '        <div class="select-wrap">'
      + '          <select class="select" id="calc-subject">' + options + '</select>'
      + '          <span class="select-arrow" aria-hidden="true"></span>'
      + '        </div>'
      + '      </div>'
      + '      <p class="calc-lede">Leave is recorded separately and does not enter the percentage.</p>'
      + '    </div>'
      + '    <div id="calc-result"></div>'
      + '  </div>'
      + '</section>';
  }

  function paintCalcResult() {
    var courses = activeCourses();
    var result = $('calc-result');
    if (!result) return;

    var course = null;
    for (var i = 0; i < courses.length; i++) {
      if (courses[i].code === state.calcKey) { course = courses[i]; break; }
    }
    if (!course) course = courses[0];
    if (!course) return;

    var projection = projectCourse(course);
    var pctClass = projectionStatusClass(projection.status);
    var safeValue;
    var safeNote;
    var safeClass;

    if (projection.status === 'low') {
      safeValue = '0';
      safeNote = 'below threshold';
      safeClass = 'is-low';
    } else if (projection.status === 'none') {
      safeValue = projection.scheduled > 0 ? String(projection.initialSafe) : '—';
      safeNote = projection.scheduled > 0 ? 'from scheduled classes' : 'no sessions';
      safeClass = 'is-quiet';
    } else if (projection.status === 'edge') {
      safeValue = '0';
      safeNote = 'attend the next class';
      safeClass = 'is-edge';
    } else if (projection.status === 'complete') {
      safeValue = '—';
      safeNote = 'semester complete';
      safeClass = 'is-quiet';
    } else {
      safeValue = String(projection.safeNow);
      safeNote = projection.safeSem > projection.safeNow
        ? 'or ' + projection.safeSem + ' this semester'
        : 'consecutive classes';
      safeClass = 'is-good';
    }

    var recoveryValue = projection.status === 'low' || projection.status === 'short' || projection.status === 'critical'
      ? String(projection.rawNeed)
      : '—';
    var recoveryNote = projection.status === 'low'
      ? 'consecutive classes'
      : projection.status === 'critical'
        ? 'out of reach'
        : projection.status === 'short'
          ? 'short of 75%'
          : 'already above';

    result.innerHTML = ''
      + '<div class="calc-results">'
      + '  <div class="calc-cell">'
      + '    <span class="calc-label">Current standing</span>'
      + '    <strong class="calc-value ' + pctClass + '">' + (projection.total > 0 ? fmtPct(projection.pct) + '<span class="calc-unit">%</span>' : '—') + '</strong>'
      + '    <span class="calc-unit">' + (projection.total > 0 ? projection.present + ' of ' + projection.total + ' attended' : 'no sessions yet') + '</span>'
      + '  </div>'
      + '  <div class="calc-cell">'
      + '    <span class="calc-label">Safe to miss now</span>'
      + '    <strong class="calc-value ' + safeClass + '">' + safeValue + '</strong>'
      + '    <span class="calc-unit">' + esc(safeNote) + '</span>'
      + '  </div>'
      + '  <div class="calc-cell">'
      + '    <span class="calc-label">To recover to 75%</span>'
      + '    <strong class="calc-value ' + (projection.status === 'low' || projection.status === 'critical' ? 'is-low' : 'is-quiet') + '">' + recoveryValue + '</strong>'
      + '    <span class="calc-unit">' + esc(recoveryNote) + '</span>'
      + '  </div>'
      + '  <div class="calc-cell">'
      + '    <span class="calc-label">Classes left</span>'
      + '    <strong class="calc-value">' + (projection.scheduled > 0 ? projection.remaining : '—') + '</strong>'
      + '    <span class="calc-unit">' + (projection.scheduled > 0 ? 'of ' + projection.scheduled + ' scheduled' : 'not on timetable') + '</span>'
      + '  </div>'
      + '</div>'
      + '<p class="calc-note">' + projectionText(projection) + '</p>';
  }

  function dashboardCourses() {
    return activeCourses().slice().sort(function (a, b) {
      var pa = projectCourse(a);
      var pb = projectCourse(b);
      var ka = pa.total > 0 ? pa.pct : 101;
      var kb = pb.total > 0 ? pb.pct : 101;
      if (ka !== kb) return ka - kb;
      return a.name.localeCompare(b.name);
    });
  }

  function renderDashboard() {
    var container = $('dashboard-content');
    var lede = $('dashboard-lede');
    if (!container || !state.data) return;

    var courses = activeCourses();
    var displayCourses = dashboardCourses();
    var scope = scopeDescription(courses);

    if (lede) {
      lede.innerHTML = '<strong>' + esc(scope.semester) + '</strong>'
        + (scope.sessions ? ' · ' + esc(scope.sessions) : '')
        + ' · ' + scope.courses + ' ' + plural(scope.courses, 'subject', 'subjects')
        + ' · ' + scope.records + ' ' + plural(scope.records, 'session', 'sessions')
        + ' on the register.';
    }

    if (!courses.length) {
      container.innerHTML = '<div class="empty-state">'
        + '<span class="empty-mark" aria-hidden="true">—</span>'
        + '<h3 class="empty-title">Nothing on this register</h3>'
        + '<p class="empty-copy">Samarth returned no subjects for this semester. Use Refresh, or choose another semester from the register bar.</p>'
        + '</div>';
      container.onclick = null;
      return;
    }

    var aggregate = aggregateFor(courses);
    var projection = overallProjection(aggregate);
    var showSemester = state.currentSem === 'all';

    container.innerHTML = statStripHtml(aggregate, projection)
      + overviewHtml(aggregate, projection)
      + '<section class="section">'
      + '  <div class="section-head">'
      + '    <div class="section-title-wrap">'
      + '      <p class="mono-label">02 / Subjects</p>'
      + '      <h2>Standing by subject</h2>'
      + '    </div>'
      + '    <p class="section-note">Open any row to read its session log. Rows are ordered from the lowest attendance upward.</p>'
      + '  </div>'
      + subjectListHtml(displayCourses, 'dashboard', showSemester)
      + '</section>'
      + renderCalculatorHtml(displayCourses);

    container.onclick = function (event) { handleSubjectClick(event, container); };

    var calcSelect = $('calc-subject');
    if (calcSelect) {
      calcSelect.onchange = function () {
        state.calcKey = this.value;
        paintCalcResult();
      };
    }
    paintCalcResult();
  }

  /* ============================================================
     Subjects view
     ============================================================ */

  function subjectViewCourses() {
    var courses = activeCourses().slice();
    if (state.subjectFilter === 'below') {
      courses = courses.filter(function (course) {
        var projection = projectCourse(course);
        return projection.total > 0 && projection.pct < THRESHOLD;
      });
    }

    courses.sort(function (a, b) {
      if (state.subjectSort === 'name') {
        return a.name.localeCompare(b.name);
      }
      var pa = projectCourse(a);
      var pb = projectCourse(b);
      var ka = pa.total > 0 ? pa.pct : (state.subjectSort === 'high' ? -1 : 101);
      var kb = pb.total > 0 ? pb.pct : (state.subjectSort === 'high' ? -1 : 101);
      if (state.subjectSort === 'high') {
        if (kb !== ka) return kb - ka;
      } else if (ka !== kb) {
        return ka - kb;
      }
      return a.name.localeCompare(b.name);
    });

    return courses;
  }

  function updateSubjectList() {
    var list = $('subject-list');
    if (!list) return;
    var allCourses = activeCourses();
    var shown = subjectViewCourses();
    list.innerHTML = subjectListHtml(shown, 'subjects', state.currentSem === 'all');

    var count = $('subject-count');
    if (count) {
      count.textContent = shown.length + ' of ' + allCourses.length + ' ' + plural(allCourses.length, 'subject', 'subjects');
    }
  }

  function renderSubjects() {
    var container = $('subjects-content');
    var lede = $('subjects-lede');
    if (!container || !state.data) return;

    var courses = activeCourses();
    if (lede) {
      lede.innerHTML = '<strong>' + esc(semesterLabel(state.currentSem)) + '</strong> · '
        + courses.length + ' ' + plural(courses.length, 'subject', 'subjects')
        + ' on the register. Sort by standing, filter to the ones below 75%, then open a row for its full session log.';
    }

    if (!courses.length) {
      container.innerHTML = '<div class="empty-state">'
        + '<span class="empty-mark" aria-hidden="true">—</span>'
        + '<h3 class="empty-title">No subjects on this register</h3>'
        + '<p class="empty-copy">Samarth returned no enrolled subjects for this semester. Try refreshing, or choose another semester above.</p>'
        + '</div>';
      container.onclick = null;
      return;
    }

    container.innerHTML = '<div class="subject-toolbar">'
      + '  <div class="toolbar-group">'
      + '    <span class="mono-label">Sort</span>'
      + '    <div class="select-wrap">'
      + '      <select class="select" id="subject-sort" aria-label="Sort subjects">'
      + '        <option value="low"' + (state.subjectSort === 'low' ? ' selected' : '') + '>Attendance: low to high</option>'
      + '        <option value="high"' + (state.subjectSort === 'high' ? ' selected' : '') + '>Attendance: high to low</option>'
      + '        <option value="name"' + (state.subjectSort === 'name' ? ' selected' : '') + '>Name: A–Z</option>'
      + '      </select>'
      + '      <span class="select-arrow" aria-hidden="true"></span>'
      + '    </div>'
      + '  </div>'
      + '  <div class="toolbar-group">'
      + '    <span class="mono-label">Filter</span>'
      + '    <div class="segmented" role="group" aria-label="Filter subjects">'
      + '      <button type="button" class="filter-btn" data-subject-filter="all" aria-pressed="' + (state.subjectFilter === 'all' ? 'true' : 'false') + '">All</button>'
      + '      <button type="button" class="filter-btn" data-subject-filter="below" aria-pressed="' + (state.subjectFilter === 'below' ? 'true' : 'false') + '">Below 75%</button>'
      + '    </div>'
      + '    <span class="scope-count" id="subject-count"></span>'
      + '  </div>'
      + '</div>'
      + '<div id="subject-list"></div>';

    container.onclick = function (event) { handleSubjectClick(event, container); };

    var sort = $('subject-sort');
    if (sort) {
      sort.onchange = function () {
        state.subjectSort = this.value;
        updateSubjectList();
      };
    }

    updateSubjectList();
  }

  /* ============================================================
     Session history view
     ============================================================ */

  function historyEntries(courses) {
    var entries = [];
    for (var i = 0; i < courses.length; i++) {
      var course = courses[i];
      for (var j = 0; j < course.records.length; j++) {
        var record = course.records[j];
        var parsed = parseSessionDate(record.date);
        entries.push({
          course: course,
          record: record,
          ts: parsed ? parsed.getTime() : null,
          order: entries.length
        });
      }
    }
    entries.sort(function (a, b) {
      if (a.ts === null && b.ts === null) return a.order - b.order;
      if (a.ts === null) return 1;
      if (b.ts === null) return -1;
      return b.ts - a.ts;
    });
    return entries;
  }

  function historyEntriesHtml(entries) {
    if (!entries.length) {
      return '<div class="empty-state">'
        + '<span class="empty-mark" aria-hidden="true">—</span>'
        + '<h3 class="empty-title">No sessions marked yet</h3>'
        + '<p class="empty-copy">Samarth has not recorded any session for this semester. Once a class is marked, its date, time, subject and status will appear here.</p>'
        + '</div>';
    }

    var groups = [];
    var map = {};
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var key = monthKey(entry.record.date);
      if (!map[key]) {
        map[key] = { key: key, title: monthTitle(entry.record.date), entries: [] };
        groups.push(map[key]);
      }
      map[key].entries.push(entry);
    }

    var html = '';
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var rows = '';
      for (var r = 0; r < group.entries.length; r++) {
        var item = group.entries[r];
        var parts = dateParts(item.record.date);
        var code = item.course.baseCode || item.course.code || '';
        rows += '<article class="history-entry" data-course="' + item.course.index + '" data-status="' + esc(item.record.status) + '">'
          + '  <div class="history-date">' + esc(parts.display)
          + (parts.weekday ? '<span class="history-weekday">' + esc(parts.weekday) + '</span>' : '')
          + '  </div>'
          + '  <div class="history-subject">'
          + '    <span class="history-name">' + esc(item.course.name) + '</span>'
          + '    <span class="history-code">' + esc(code || 'Uncoded subject') + '</span>'
          + '  </div>'
          + '  <div class="history-time">' + esc(cleanTime(item.record.time)) + '</div>'
          + '  <div class="history-status">' + statusTag(item.record.status) + '</div>'
          + '</article>';
      }

      html += '<section class="history-group" data-history-group>'
        + '  <div class="history-group-head">'
        + '    <h3>' + esc(group.title) + '</h3>'
        + '    <span class="history-group-count"><span data-group-count>' + group.entries.length + '</span> ' + plural(group.entries.length, 'entry', 'entries') + '</span>'
        + '  </div>'
        + rows
        + '</section>';
    }
    return html;
  }

  function updateHistoryStatusCounts() {
    var courses = activeCourses();
    if (state.historySubject !== 'all') {
      courses = courses.filter(function (course) {
        return String(course.index) === String(state.historySubject);
      });
    }

    var counts = { all: 0, Present: 0, Absent: 0, Leave: 0 };
    for (var i = 0; i < courses.length; i++) {
      var records = courses[i].records || [];
      for (var j = 0; j < records.length; j++) {
        counts.all++;
        counts[records[j].status] = (counts[records[j].status] || 0) + 1;
      }
    }

    all('[data-history-count]').forEach(function (element) {
      var key = element.getAttribute('data-history-count');
      element.textContent = counts[key] || 0;
    });
  }

  function applyHistoryFilters() {
    var body = $('history-body');
    if (!body) return;

    var subject = state.historySubject;
    var status = state.historyStatus;
    var visible = 0;
    var total = 0;

    all('.history-entry', body).forEach(function (entry) {
      total++;
      var subjectMatch = subject === 'all' || entry.getAttribute('data-course') === String(subject);
      var statusMatch = status === 'all' || entry.getAttribute('data-status') === status;
      var show = subjectMatch && statusMatch;
      entry.hidden = !show;
      if (show) visible++;
    });

    all('[data-history-group]', body).forEach(function (group) {
      var groupVisible = 0;
      all('.history-entry', group).forEach(function (entry) {
        if (!entry.hidden) groupVisible++;
      });
      group.hidden = groupVisible === 0;
      var count = group.querySelector('[data-group-count]');
      if (count) count.textContent = groupVisible;
    });

    var empty = $('history-empty');
    if (empty) empty.hidden = visible !== 0;

    var countLabel = $('history-count');
    if (countLabel) {
      countLabel.textContent = 'Showing ' + visible + ' of ' + total + ' ' + plural(total, 'entry', 'entries');
    }

    var reset = $('history-reset');
    if (reset) reset.hidden = subject === 'all' && status === 'all';
  }

  function renderHistory() {
    var container = $('history-content');
    var lede = $('history-lede');
    if (!container || !state.data) return;

    var courses = activeCourses();
    var entries = historyEntries(courses);

    if (lede) {
      lede.innerHTML = '<strong>' + esc(semesterLabel(state.currentSem)) + '</strong> · '
        + entries.length + ' ' + plural(entries.length, 'session', 'sessions') + ' across '
        + courses.length + ' ' + plural(courses.length, 'subject', 'subjects') + '. Newest first; filter by subject or attendance status.';
    }

    if (state.historySubject !== 'all') {
      var exists = courses.some(function (course) {
        return String(course.index) === String(state.historySubject);
      });
      if (!exists) state.historySubject = 'all';
    }
    if (['all', 'Present', 'Absent', 'Leave'].indexOf(state.historyStatus) === -1) {
      state.historyStatus = 'all';
    }

    var options = '<option value="all"' + (state.historySubject === 'all' ? ' selected' : '') + '>All subjects</option>';
    for (var i = 0; i < courses.length; i++) {
      var course = courses[i];
      var code = course.baseCode || course.code || '';
      options += '<option value="' + course.index + '"' + (String(state.historySubject) === String(course.index) ? ' selected' : '') + '>'
        + esc(course.name + (code ? ' · ' + code : '')) + ' (' + (course.records || []).length + ')</option>';
    }

    var statuses = [
      { key: 'all', label: 'All' },
      { key: 'Present', label: 'Present' },
      { key: 'Absent', label: 'Absent' },
      { key: 'Leave', label: 'Leave' }
    ];
    var statusButtons = '';
    for (var s = 0; s < statuses.length; s++) {
      var item = statuses[s];
      statusButtons += '<button type="button" class="filter-btn" data-history-status="' + item.key + '" aria-pressed="'
        + (state.historyStatus === item.key ? 'true' : 'false') + '">'
        + item.label + ' <span class="filter-count" data-history-count="' + item.key + '">0</span></button>';
    }

    container.innerHTML = '<div class="history-toolbar">'
      + '  <div class="history-filters">'
      + '    <div class="filter-group">'
      + '      <label for="history-subject">Subject</label>'
      + '      <div class="select-wrap">'
      + '        <select class="select" id="history-subject">' + options + '</select>'
      + '        <span class="select-arrow" aria-hidden="true"></span>'
      + '      </div>'
      + '    </div>'
      + '    <div class="filter-group">'
      + '      <span class="filter-group-label mono-label">Status</span>'
      + '      <div class="segmented" role="group" aria-label="Filter by attendance status">' + statusButtons + '</div>'
      + '    </div>'
      + '  </div>'
      + '  <div class="history-meta">'
      + '    <span class="history-count" id="history-count">Showing 0 of 0 entries</span>'
      + '    <button type="button" class="text-link" id="history-reset" hidden>Clear filters</button>'
      + '  </div>'
      + '</div>'
      + '<div class="history-body" id="history-body">'
      + historyEntriesHtml(entries)
      + '<div class="empty-state" id="history-empty" hidden>'
      + '  <span class="empty-mark" aria-hidden="true">—</span>'
      + '  <h3 class="empty-title">No sessions match these filters</h3>'
      + '  <p class="empty-copy">Try another subject or status, or clear the filters to read the full register.</p>'
      + '</div>'
      + '</div>';

    container.onchange = function (event) {
      if (event.target && event.target.id === 'history-subject') {
        state.historySubject = event.target.value;
        updateHistoryStatusCounts();
        applyHistoryFilters();
      }
    };

    container.onclick = function (event) {
      var statusButton = event.target.closest('[data-history-status]');
      if (statusButton) {
        state.historyStatus = statusButton.getAttribute('data-history-status');
        all('[data-history-status]', container).forEach(function (button) {
          button.setAttribute('aria-pressed', button === statusButton ? 'true' : 'false');
        });
        applyHistoryFilters();
        return;
      }

      var reset = event.target.closest('#history-reset');
      if (reset) {
        state.historySubject = 'all';
        state.historyStatus = 'all';
        var select = $('history-subject');
        if (select) select.value = 'all';
        all('[data-history-status]', container).forEach(function (button) {
          button.setAttribute('aria-pressed', button.getAttribute('data-history-status') === 'all' ? 'true' : 'false');
        });
        updateHistoryStatusCounts();
        applyHistoryFilters();
      }
    };

    updateHistoryStatusCounts();
    applyHistoryFilters();
  }

  /* ============================================================
     View rendering and routing
     ============================================================ */

  function renderDataViews() {
    renderDashboard();
    renderSubjects();
    renderHistory();
  }

  function showView(route) {
    var display = 'login';
    if (state.data) {
      display = ROUTES.indexOf(route) !== -1 ? route : 'dashboard';
      state.view = display;
    }

    all('.view').forEach(function (view) {
      view.hidden = view.getAttribute('data-view') !== display;
    });

    all('.main-nav a').forEach(function (link) {
      if (state.data && link.getAttribute('data-route') === display) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  function onRouteChange() {
    var route = routeFromHash();
    state.view = route;
    if (state.data) {
      showView(route);
      window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }

  /* ============================================================
     Toasts
     ============================================================ */

  function showToast(message, type) {
    var stack = $('toast-stack');
    if (!stack) return;
    var toast = document.createElement('div');
    toast.className = 'toast' + (type === 'success' ? ' is-success' : type === 'error' ? ' is-error' : '');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.textContent = message;
    stack.appendChild(toast);

    window.setTimeout(function () {
      toast.classList.add('is-leaving');
      window.setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 220);
    }, 5000);
  }

  /* ============================================================
     Account menu
     ============================================================ */

  function accountMenuItems() {
    return all('#account-menu .menu-item').filter(function (item) {
      return !item.disabled && !item.hidden;
    });
  }

  function openAccountMenu() {
    var menu = $('account-menu');
    var button = $('account-btn');
    if (!menu || !button) return;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    var items = accountMenuItems();
    if (items.length) items[0].focus();
  }

  function closeAccountMenu(returnFocus) {
    var menu = $('account-menu');
    var button = $('account-btn');
    if (!menu || !button) return;
    var wasOpen = !menu.hidden;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (wasOpen && returnFocus) button.focus();
  }

  function toggleAccountMenu() {
    var menu = $('account-menu');
    if (!menu) return;
    if (menu.hidden) openAccountMenu();
    else closeAccountMenu(true);
  }

  function handleMenuKeydown(event) {
    var menu = $('account-menu');
    if (!menu || menu.hidden) return;
    var items = accountMenuItems();
    if (!items.length) return;
    var index = items.indexOf(document.activeElement);

    if (event.key === 'Escape') {
      event.preventDefault();
      closeAccountMenu(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1 + items.length) % items.length].focus();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length].focus();
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      items[0].focus();
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1].focus();
      return;
    }
    if (event.key === 'Tab') {
      closeAccountMenu(false);
    }
  }

  /* ============================================================
     Author modal
     ============================================================ */

  function modalFocusable() {
    var modal = $('author-modal');
    if (!modal) return [];
    return all('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', modal)
      .filter(function (element) { return element.offsetParent !== null; });
  }

  function openAuthorModal() {
    var modal = $('author-modal');
    if (!modal) return;
    if (modalTimer) {
      window.clearTimeout(modalTimer);
      modalTimer = null;
    }
    lastModalFocus = document.activeElement;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    void modal.offsetWidth;
    modal.classList.add('is-active');
    document.body.style.overflow = 'hidden';
    var close = $('modal-close');
    if (close) close.focus();
  }

  function closeAuthorModal() {
    var modal = $('author-modal');
    if (!modal || !modal.classList.contains('is-active')) return;
    modal.classList.remove('is-active');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    modalTimer = window.setTimeout(function () {
      if (!modal.classList.contains('is-active')) modal.hidden = true;
      modalTimer = null;
    }, 210);
    if (lastModalFocus && typeof lastModalFocus.focus === 'function') {
      lastModalFocus.focus();
      lastModalFocus = null;
    }
  }

  function handleModalKeydown(event) {
    var modal = $('author-modal');
    if (!modal || !modal.classList.contains('is-active')) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeAuthorModal();
      return;
    }

    if (event.key === 'Tab') {
      var focusable = modalFocusable();
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  /* ============================================================
     Boot
     ============================================================ */

  function init() {
    syncThemeUi();

    var stored = readStoredCredentials();
    var usernameField = $('u');
    var passwordField = $('p');
    var remember = $('remember');

    try { localStorage.removeItem(LEGACY_ATTENDANCE_KEY); } catch (e) { /* ignore */ }

    if (stored && usernameField && passwordField) {
      usernameField.value = stored.username;
      passwordField.value = stored.password;
      if (remember) remember.checked = true;
    }

    if (!workerUrl()) {
      showLoginError('The attendance worker is not configured. Set window.DCRUSTM_WORKER in config.js.');
      if ($('go')) $('go').disabled = true;
    }

    var themeToggle = $('theme-toggle');
    if (themeToggle) themeToggle.addEventListener('click', toggleTheme);

    var passwordToggle = $('pw-toggle');
    if (passwordToggle && passwordField) {
      passwordToggle.addEventListener('click', function () {
        var showing = passwordField.type === 'text';
        passwordField.type = showing ? 'password' : 'text';
        passwordToggle.classList.toggle('is-visible', !showing);
        passwordToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
        passwordField.focus();
      });
    }

    var form = $('login-form');
    if (form) form.addEventListener('submit', handleLoginSubmit);

    ['u', 'p'].forEach(function (fieldId) {
      var input = $(fieldId);
      if (!input) return;
      input.addEventListener('input', function () {
        setFieldError(fieldId, '');
      });
    });

    var semesterSelect = $('semester-select');
    if (semesterSelect) {
      semesterSelect.addEventListener('change', function () {
        handleSemesterChange(this.value);
      });
    }

    var refresh = $('refresh-btn');
    if (refresh) refresh.addEventListener('click', handleRefresh);

    var menuRefresh = $('menu-refresh');
    if (menuRefresh) menuRefresh.addEventListener('click', function () {
      closeAccountMenu(false);
      handleRefresh();
    });

    var accountBtn = $('account-btn');
    if (accountBtn) accountBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleAccountMenu();
    });

    var signOutButton = $('menu-signout');
    if (signOutButton) signOutButton.addEventListener('click', signOut);

    document.addEventListener('click', function (event) {
      var account = $('account');
      var menu = $('account-menu');
      if (account && menu && !menu.hidden && !account.contains(event.target)) {
        closeAccountMenu(false);
      }
    });

    var authorButton = $('author-modal-btn');
    if (authorButton) authorButton.addEventListener('click', openAuthorModal);

    var modalClose = $('modal-close');
    if (modalClose) modalClose.addEventListener('click', closeAuthorModal);

    var modalBackdrop = $('modal-backdrop');
    if (modalBackdrop) modalBackdrop.addEventListener('click', closeAuthorModal);

    document.addEventListener('keydown', function (event) {
      handleModalKeydown(event);
      if (!event.defaultPrevented) handleMenuKeydown(event);
    });

    window.addEventListener('hashchange', onRouteChange);

    state.view = routeFromHash();
    showView('login');
  }

  init();
}());

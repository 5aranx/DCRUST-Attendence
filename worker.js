function getCorsHeaders(req) {
  const o = req ? (req.headers.get('Origin') || '') : '';
  let a = '*';
  if (o) {
    try {
      const u = new URL(o);
      if (u.hostname.endsWith('.github.io') || u.hostname === 'localhost' || u.hostname === '127.0.0.1') a = o;
    } catch (_) {}
  }
  return {
    'Access-Control-Allow-Origin': a,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
  });
}

const ipLimits = new Map();
const failedAttempts = new Map();
const cache = new Map();

async function hashKey(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function checkIpLimit(ip) {
  const now = Date.now(), rec = ipLimits.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 60000; }
  rec.count++;
  ipLimits.set(ip, rec);
  return rec.count <= 10;
}

function checkLockout(u) {
  const r = failedAttempts.get(u);
  if (!r) return { locked: false };
  if (r.count >= 3 && Date.now() < r.lockedUntil) {
    return { locked: true, waitSecs: Math.ceil((r.lockedUntil - Date.now()) / 1000) };
  }
  if (r.lockedUntil && Date.now() >= r.lockedUntil) failedAttempts.delete(u);
  return { locked: false };
}

function recordFail(u) {
  const r = failedAttempts.get(u) || { count: 0, lockedUntil: 0 };
  r.count++;
  if (r.count >= 3) r.lockedUntil = Date.now() + 120000;
  failedAttempts.set(u, r);
}

function getCache(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.time > 600000) { cache.delete(k); return null; }
  return e.data;
}

function setCache(k, d) {
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(k, { time: Date.now(), data: d });
}

function mergeSetCookie(jar, headers) {
  const cookies = headers.getSetCookie ? headers.getSetCookie() : [];
  for (const raw of cookies) {
    const pair = raw.split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function followRedirects(url, init, jar, maxHops) {
  let current = url, hops = 0;
  while (hops < (maxHops || 10)) {
    const res = await fetch(current, { ...init, redirect: 'manual' });
    mergeSetCookie(jar, res.headers);
    const loc = res.headers.get('location');
    if ((res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) && loc) {
      current = loc.startsWith('http') ? loc : new URL(loc, current).href;
      if (res.status !== 307 && res.status !== 308) {
        init = { headers: init.headers, redirect: 'manual', signal: init.signal };
      }
      hops++;
    } else {
      return res;
    }
  }
  throw new Error('too many redirects');
}

async function pLimit(concurrency, tasks) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  const pool = [];
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
    pool.push(worker());
  }
  await Promise.all(pool);
  return results;
}

function parseRecords(html) {
  const records = [];
  const rowRegex = /<tr[^>]*data-key="\d+"><td>\d+<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]*)<\/td><\/tr>/gi;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const rawStatus = m[3].trim().toUpperCase();
    let status = 'Present';
    if (rawStatus === 'ABSENT' || rawStatus === 'A') status = 'Absent';
    else if (rawStatus === 'LEAVE' || rawStatus === 'L') status = 'Leave';
    records.push({ date: m[1].trim(), time: m[2].trim(), status, remarks: m[4].trim() });
  }
  return records;
}

const BASE = 'https://dcrustm.samarth.edu.in';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname === '/attendance') {
      return new Response(null, { status: 204, headers: getCorsHeaders(request) });
    }

    if (request.method !== 'POST' || url.pathname !== '/attendance') {
      return json({ error: 'not found' }, 404, request);
    }

    const origin = request.headers.get('Origin');
    if (origin) {
      try {
        const u = new URL(origin);
        if (!u.hostname.endsWith('.github.io') && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
          return json({ error: 'Forbidden origin' }, 403, request);
        }
      } catch (_) {
        return json({ error: 'Forbidden origin' }, 403, request);
      }
    }

    const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'anon';
    if (!checkIpLimit(clientIp)) {
      return json({ error: 'Too many requests from this IP. Please wait a minute.' }, 429, request);
    }

    try {
      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'invalid JSON body' }, 400, request);
      }

      const username = (body.username || '').trim();
      const password = body.password || '';
      if (!username || !password) {
        return json({ error: 'missing username or password' }, 400, request);
      }

      if (!/^[0-9]{8,16}$/.test(username)) {
        return json({ error: 'Invalid roll number format. Roll number should be 8-16 digits.' }, 400, request);
      }

      const lockout = checkLockout(username);
      if (lockout.locked) {
        return json({ error: 'Too many failed login attempts for ' + username + '. Please wait ' + lockout.waitSecs + 's before trying again.' }, 429, request);
      }

      const cacheKey = username + ':' + (await hashKey(password));
      const cached = getCache(cacheKey);
      if (cached) {
        return json(cached, 200, request);
      }

      const jar = new Map();

      // Step 1: Fetch login page
      let loginPage;
      try {
        loginPage = await fetch(`${BASE}/index.php/site/login`, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
      } catch (_) {
        return json({ error: 'upstream error' }, 502, request);
      }

      if (!loginPage.ok) return json({ error: 'upstream error' }, 502, request);

      mergeSetCookie(jar, loginPage.headers);
      const loginHtml = await loginPage.text();

      const csrfTokenMatch = loginHtml.match(/<meta name="csrf-token" content="([^"]+)"/);
      const csrfParamMatch = loginHtml.match(/<meta name="csrf-param" content="([^"]+)"/);
      if (!csrfTokenMatch || !csrfParamMatch) return json({ error: 'unexpected login page' }, 502, request);

      const csrfToken = csrfTokenMatch[1], csrfParam = csrfParamMatch[1];
      let usernameField = 'LoginForm[username]', passwordField = 'LoginForm[password]';
      const uMatch = loginHtml.match(/name="([^"]*username[^"]*)"/i);
      const pMatch = loginHtml.match(/name="([^"]*password[^"]*)"/i);
      if (uMatch) usernameField = uMatch[1];
      if (pMatch) passwordField = pMatch[1];

      // Step 2: POST credentials
      const formBody = new URLSearchParams();
      formBody.set(csrfParam, csrfToken);
      formBody.set(usernameField, username);
      formBody.set(passwordField, password);

      let loginPost;
      try {
        loginPost = await followRedirects(`${BASE}/index.php/site/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieHeader(jar) },
          body: formBody.toString(),
          signal: AbortSignal.timeout(15000),
        }, jar, 10);
      } catch (_) {
        return json({ error: 'upstream error' }, 502, request);
      }

      mergeSetCookie(jar, loginPost.headers);
      await loginPost.text();

      // Step 3: Verify login and fetch timetable in parallel
      let attendancePage, timetablePage;
      try {
        [attendancePage, timetablePage] = await Promise.all([
          fetch(`${BASE}/index.php/student-attendance/attendance/index`, {
            headers: { 'Cookie': cookieHeader(jar) },
            redirect: 'follow',
            signal: AbortSignal.timeout(15000),
          }),
          fetch(`${BASE}/index.php/student-attendance/attendance/view-time-table`, {
            headers: { 'Cookie': cookieHeader(jar) },
            redirect: 'follow',
            signal: AbortSignal.timeout(15000),
          }).catch(() => null),
        ]);
      } catch (_) {
        return json({ error: 'upstream error' }, 502, request);
      }

      mergeSetCookie(jar, attendancePage.headers);
      const attendanceHtml = await attendancePage.text();

      if (!attendanceHtml.includes('Enrolled Classes')) {
        recordFail(username);
        const rec = failedAttempts.get(username);
        const left = 3 - (rec ? rec.count : 0);
        if (left <= 0) {
          return json({ error: 'Invalid credentials. Account locked for 2 minutes due to 3 failed attempts.' }, 401, request);
        }
        return json({ error: 'Invalid credentials. (' + left + ' attempt' + (left === 1 ? '' : 's') + ' left before 2-minute lockout)' }, 401, request);
      }

      let studentId = '';
      if (timetablePage && timetablePage.ok) {
        mergeSetCookie(jar, timetablePage.headers);
        const ttHtml = await timetablePage.text();
        const idMatch = ttHtml.match(/data-student-id="([^"]+)"/);
        if (idMatch) studentId = idMatch[1];
      }

      // Step 4: Parse class list
      const classRe = /<tr class="text-center">\s*<td>\d+<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>[^<]*<\/td>\s*<td>[^<]*<\/td>\s*<td><a[^>]*href="([^"]+)"[^>]*>View<\/a>/g;
      const classes = [];
      let classMatch;
      while ((classMatch = classRe.exec(attendanceHtml)) !== null) {
        classes.push({ className: classMatch[1].trim(), courseName: classMatch[2].trim(), href: classMatch[3] });
      }

      if (classes.length === 0) return json({ error: 'unexpected class list layout' }, 502, request);

      // Step 5: Fetch timetable API and class attendance in parallel
      let ttPromise = Promise.resolve([]);
      if (studentId) {
        ttPromise = fetch(`${BASE}/index.php/student-attendance/attendance-api/get-classes-of-student?student_id=${studentId}`, {
          headers: { 'Cookie': cookieHeader(jar) },
          redirect: 'follow',
          signal: AbortSignal.timeout(15000),
        }).then((r) => r.json()).then((j) => (j && Array.isArray(j.data)) ? j.data : []).catch(() => []);
      }

      const tasks = classes.map((cls) => async () => {
        try {
          const fetchUrl = `${BASE}${cls.href}${cls.href.includes('?') ? '&' : '?'}per-page=100`;
          const res = await fetch(fetchUrl, { headers: { 'Cookie': cookieHeader(jar) }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
          const html = await res.text();
          const records = parseRecords(html);
          const m = html.match(/Total Classes Taken:\s*(\d+),\s*Present Count:\s*(\d+),\s*Absent Count:\s*(\d+),\s*Leave Count:\s*(\d+)/);
          const teacherM = html.match(/<th>Teacher Name<\/th>\s*<td>([^<]+)<\/td>/i);
          const rawTeacher = teacherM ? teacherM[1].trim() : '';
          const teacher = rawTeacher.replace(/^\s*\([^\)]*\)\s*/, '').replace(/\s+/g, ' ');

          if (!m) return { ...cls, total: 0, present: 0, absent: 0, leave: 0, teacher, records };
          return {
            ...cls,
            total: parseInt(m[1], 10),
            present: parseInt(m[2], 10),
            absent: parseInt(m[3], 10),
            leave: parseInt(m[4], 10),
            teacher,
            records,
          };
        } catch (_) {
          return { ...cls, total: 0, present: 0, absent: 0, leave: 0, teacher: '', records: [] };
        }
      });

      const [fetched, timetableSlots] = await Promise.all([pLimit(3, tasks), ttPromise]);

      // Step 6: Compute distinct classes and metrics
      let totalPresent = 0, totalAbsent = 0, totalLeave = 0;
      let totalSemesterScheduled = 0, totalSemesterRemaining = 0;
      const courses = [];

      for (const row of fetched) {
        const codeMatch = /^([A-Z0-9]+)\s*:/.exec(row.courseName);
        const baseCode = codeMatch ? codeMatch[1] : row.className;
        const nameMatch = /:\s*(.*)$/.exec(row.courseName);
        const name = nameMatch ? nameMatch[1].trim() : row.courseName;

        const total = row.present + row.absent;
        const pct = total > 0 ? +(row.present / total * 100).toFixed(2) : 0;

        const matchingSlots = timetableSlots.filter((s) => s.title === row.className);
        const scheduled = matchingSlots.length;
        const remaining = scheduled > 0 ? Math.max(0, scheduled - total) : 0;

        totalPresent += row.present;
        totalAbsent += row.absent;
        totalLeave += row.leave;
        totalSemesterScheduled += scheduled;
        totalSemesterRemaining += remaining;

        courses.push({
          code: row.className,
          baseCode: baseCode,
          name: name,
          classes: [row.className],
          teacher: row.teacher || '',
          present: row.present,
          absent: row.absent,
          leave: row.leave,
          total: total,
          pct: pct,
          scheduled: scheduled,
          remaining: remaining,
          records: row.records || [],
        });
      }

      courses.sort((a, b) => a.pct - b.pct);

      const overallTotal = totalPresent + totalAbsent;
      const overallPct = overallTotal > 0 ? +(totalPresent / overallTotal * 100).toFixed(2) : 0;

      failedAttempts.delete(username);

      const responseData = {
        username,
        fetchedAt: new Date().toISOString(),
        overall: {
          present: totalPresent,
          absent: totalAbsent,
          leave: totalLeave,
          total: overallTotal,
          pct: overallPct,
          scheduled: totalSemesterScheduled,
          remaining: totalSemesterRemaining,
        },
        courses,
      };

      setCache(cacheKey, responseData);
      return json(responseData, 200, request);

    } catch (_) {
      return json({ error: 'upstream error' }, 500, request);
    }
  },
};

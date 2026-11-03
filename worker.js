const ALLOWED_ORIGINS = new Set([
  'https://vishvjeetdahiya.github.io',
  'http://localhost:8000',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:5500',
]);

function getCorsHeaders(req) {
  const o = req ? (req.headers.get('Origin') || '') : '';
  const allowed = ALLOWED_ORIGINS.has(o) ? o : null;
  return {
    ...(allowed ? { 'Access-Control-Allow-Origin': allowed } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req), ...extraHeaders },
  });
}

const ipLimits = new Map();
const ipFailedLogins = new Map();
const userFailedLogins = new Map();
const cache = new Map();

function getClientIp(req) {
  return req.headers.get('cf-connecting-ip')
    || req.headers.get('x-real-ip')
    || (req.headers.get('x-forwarded-for') ? req.headers.get('x-forwarded-for').split(',')[0].trim() : '')
    || 'anon';
}

function checkIpRateLimit(ip) {
  const now = Date.now();
  let rec = ipLimits.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + 60000, violations: rec ? rec.violations : 0, blockUntil: 0 };
  }
  if (now < rec.blockUntil) {
    const waitSecs = Math.ceil((rec.blockUntil - now) / 1000);
    return { allowed: false, waitSecs };
  }
  rec.count++;
  if (rec.count > 6) {
    rec.violations = (rec.violations || 0) + 1;
    const blockDuration = rec.violations >= 3 ? 900000 : (rec.violations === 2 ? 300000 : 60000);
    rec.blockUntil = now + blockDuration;
    ipLimits.set(ip, rec);
    return { allowed: false, waitSecs: Math.ceil(blockDuration / 1000) };
  }
  ipLimits.set(ip, rec);
  return { allowed: true };
}

function checkIpLoginLockout(ip) {
  const now = Date.now();
  const rec = ipFailedLogins.get(ip);
  if (!rec) return { locked: false };
  if (now < rec.lockedUntil) {
    return { locked: true, waitSecs: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  if (now >= rec.lockedUntil) {
    ipFailedLogins.delete(ip);
  }
  return { locked: false };
}

function recordIpLoginFailure(ip) {
  const now = Date.now();
  const rec = ipFailedLogins.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= 5) {
    rec.lockedUntil = now + 900000; // 15 mins
  } else if (rec.count >= 3) {
    rec.lockedUntil = now + 180000; // 3 mins
  }
  ipFailedLogins.set(ip, rec);
}

function checkUserLockout(username) {
  const now = Date.now();
  const rec = userFailedLogins.get(username);
  if (!rec) return { locked: false };
  if (now < rec.lockedUntil) {
    return { locked: true, waitSecs: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  if (now >= rec.lockedUntil) {
    userFailedLogins.delete(username);
  }
  return { locked: false };
}

function recordUserLoginFailure(username) {
  const now = Date.now();
  const rec = userFailedLogins.get(username) || { count: 0, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= 5) {
    rec.lockedUntil = now + 900000; // 15 mins
  } else if (rec.count >= 3) {
    rec.lockedUntil = now + 180000; // 3 mins
  }
  userFailedLogins.set(username, rec);
}

async function hashKey(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
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
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS' && url.pathname === '/attendance') {
      if (!origin || !ALLOWED_ORIGINS.has(origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: getCorsHeaders(request) });
    }

    if (request.method !== 'POST' || url.pathname !== '/attendance') {
      return json({ error: 'not found' }, 404, request);
    }

    // Strict origin allowlist check: prevents CSRF, unauthorized scripts, and abuse
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      return json({ error: 'Access forbidden: unauthorized origin' }, 403, request);
    }

    const clientIp = getClientIp(request);

    // IP-level request rate limit (max 6 requests per 60 seconds)
    const rateCheck = checkIpRateLimit(clientIp);
    if (!rateCheck.allowed) {
      return json(
        { error: `Too many requests from this network. Please wait ${rateCheck.waitSecs}s.` },
        429,
        request,
        { 'Retry-After': String(rateCheck.waitSecs) }
      );
    }

    // IP-level failed login lockout (anti-credential stuffing across accounts)
    const ipLock = checkIpLoginLockout(clientIp);
    if (ipLock.locked) {
      return json(
        { error: `Too many failed login attempts from this network. Temporarily blocked for ${ipLock.waitSecs}s.` },
        429,
        request,
        { 'Retry-After': String(ipLock.waitSecs) }
      );
    }

    try {
      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json({ error: 'invalid JSON body' }, 400, request);
      }

      const username = (body.username || '').trim();
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username || !password) {
        return json({ error: 'missing username or password' }, 400, request);
      }

      if (!/^[0-9]{8,16}$/.test(username)) {
        return json({ error: 'Invalid roll number format. Roll number should be 8-16 digits.' }, 400, request);
      }

      if (password.length < 4 || password.length > 64) {
        return json({ error: 'Invalid password format.' }, 400, request);
      }

      const userLock = checkUserLockout(username);
      if (userLock.locked) {
        return json(
          { error: `Too many failed login attempts for ${username}. Please wait ${userLock.waitSecs}s before trying again.` },
          429,
          request,
          { 'Retry-After': String(userLock.waitSecs) }
        );
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
        loginPost = await fetch(`${BASE}/index.php/site/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieHeader(jar) },
          body: formBody.toString(),
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
        });
      } catch (_) {
        return json({ error: 'upstream error' }, 502, request);
      }

      mergeSetCookie(jar, loginPost.headers);

      const loc = loginPost.headers.get('location');
      const isRedirect = (loginPost.status === 301 || loginPost.status === 302 || loginPost.status === 303) && loc;

      if (!isRedirect) {
        recordIpLoginFailure(clientIp);
        recordUserLoginFailure(username);

        // 1.2s tarpit delay to throttle automated brute-force scripts
        await new Promise((r) => setTimeout(r, 1200));

        const uRec = userFailedLogins.get(username);
        const left = Math.max(0, 3 - (uRec ? uRec.count : 0));
        if (left === 0) {
          return json({ error: 'Invalid credentials. Account temporarily locked for 3 minutes due to 3 failed attempts.' }, 401, request);
        }
        return json({ error: `Invalid roll number or password. (${left} attempt${left === 1 ? '' : 's'} left before 3-minute lockout)` }, 401, request);
      }

      // Step 3: Fetch attendance index and timetable in parallel
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
        recordUserLoginFailure(username);
        const rec = userFailedLogins.get(username);
        const left = Math.max(0, 3 - (rec ? rec.count : 0));
        if (left === 0) {
          return json({ error: 'Invalid credentials. Account temporarily locked for 3 minutes due to 3 failed attempts.' }, 401, request);
        }
        return json({ error: `Invalid roll number or password. (${left} attempt${left === 1 ? '' : 's'} left before 3-minute lockout)` }, 401, request);
      }

      let studentId = '';
      if (timetablePage && timetablePage.ok) {
        mergeSetCookie(jar, timetablePage.headers);
        const ttHtml = await timetablePage.text();
        const idMatch = ttHtml.match(/data-student-id="([^"]+)"/);
        if (idMatch) studentId = idMatch[1];
      }

      // Step 4: Parse class list
      const stripTags = (s) => (s || '').replace(/<[^>]+>/g, '').trim();
      const trRe = /<tr[^>]*class="text-center"[^>]*>([\s\S]*?)<\/tr>/gi;
      const classes = [];
      let trMatch;
      while ((trMatch = trRe.exec(attendanceHtml)) !== null) {
        const trContent = trMatch[1];
        const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        const tds = [];
        let tdMatch;
        while ((tdMatch = tdRe.exec(trContent)) !== null) {
          tds.push(stripTags(tdMatch[1]));
        }
        const hrefMatch = trContent.match(/<a[^>]*href="([^"]+)"[^>]*>View<\/a>/i);
        if (tds.length >= 3 && hrefMatch) {
          classes.push({
            className: tds[1],
            courseName: tds[2],
            semester: tds.length >= 5 ? tds[3] : '',
            session: tds.length >= 5 ? tds[4] : '',
            href: hrefMatch[1],
          });
        }
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

      const [fetched, timetableSlots] = await Promise.all([pLimit(10, tasks), ttPromise]);

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
          semester: row.semester || '',
          session: row.session || '',
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

      const semesters = [...new Set(courses.map((c) => c.semester).filter(Boolean))];

      userFailedLogins.delete(username);
      ipFailedLogins.delete(clientIp);

      const responseData = {
        username,
        fetchedAt: new Date().toISOString(),
        semesters,
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

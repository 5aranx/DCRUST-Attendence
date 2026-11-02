# DCRUSTM attendance checker

Two independent pieces: a Cloudflare Worker (`worker.js`) that performs the SAMARTH login and attendance fetch server-side, and a static frontend (`index.html` + `config.js`) hosted on GitHub Pages.

---

## Deploy the worker

1. Open https://dash.cloudflare.com, go to Workers & Pages, and open your existing `dcrust-attendance` worker.
2. Click **Edit code**.
3. Select all existing code, delete it, paste the full contents of `worker.js`.
4. Click **Deploy**.
5. Verify:

```
curl https://dcrust-attendance.vishvjeetdahiya2008-6c3.workers.dev
```

Expected response: `{"error":"not found"}` with status 404. If you still see `Hello World!`, the deploy did not complete — repeat steps 2–4.

---

## Deploy the frontend

1. Create a public GitHub repository.
2. Add `index.html` and `config.js` at the repository root. Commit and push to the `main` branch.
3. In the repository, go to **Settings** → **Pages**. Under Source, select **Deploy from a branch**, choose branch `main`, folder `/ (root)`. Click **Save**.
4. The site will be live at `https://<username>.github.io/<repo>/` after about one minute.

Before pushing, edit `config.js` if your worker URL differs from the default. The file contains one line:

```js
window.DCRUSTM_WORKER = 'https://dcrust-attendance.vishvjeetdahiya2008-6c3.workers.dev';
```


---

## Test

Open the GitHub Pages URL in a browser.

- Enter your roll number and SAMARTH password. Click **Check attendance**.
- A table of courses sorted by attendance percentage (worst first) will appear, along with safe-bunk or attend-more counts.

If something fails, open **DevTools** → **Network**, find the request to `<worker-url>/attendance`, and inspect the response body for an `error` field.

Quick smoke tests with curl:

```sh
# Should return 404 {"error":"not found"}
curl https://dcrust-attendance.vishvjeetdahiya2008-6c3.workers.dev

# Should return 204 with CORS headers
curl -X OPTIONS https://dcrust-attendance.vishvjeetdahiya2008-6c3.workers.dev/attendance -i

# Should return 401 {"error":"invalid credentials"}
curl -X POST https://dcrust-attendance.vishvjeetdahiya2008-6c3.workers.dev/attendance \
  -H "Content-Type: application/json" \
  -d '{"username":"x","password":"y"}'

# Should return full attendance JSON (use real credentials)
curl -X POST https://dcrust-attendance.vishvjeetdahiya2008-6c3.workers.dev/attendance \
  -H "Content-Type: application/json" \
  -d '{"username":"<roll>","password":"<pass>"}'
```

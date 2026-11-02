<div align="center">

# ⚡ DCRUST Attendance Tracker

### *Because checking Samarth at 8:59 AM shouldn't give you high blood pressure.*

[![Live Site](https://img.shields.io/badge/Live%20Site-vishvjeetdahiya.github.io%2FDCRUST-7928CA?style=for-the-badge&logo=githubpages&logoColor=white)](https://vishvjeetdahiya.github.io/DCRUST/)
[![Edge Powered](https://img.shields.io/badge/Edge-Cloudflare%20Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Cached Latency](https://img.shields.io/badge/Cached%20Speed-%7E1ms-brightgreen?style=for-the-badge&logo=speedtest&logoColor=white)](https://vishvjeetdahiya.github.io/DCRUST/)
[![Made With](https://img.shields.io/badge/Made%20with-%E2%99%A5%20by%20Vishvjeet-FF69B4?style=for-the-badge&logo=instagram&logoColor=white)](https://www.instagram.com/vishvjeetdahiyaa)

<br/>

**[🚀 Launch Attendance Tracker](https://vishvjeetdahiya.github.io/DCRUST/)** &nbsp;&bull;&nbsp; **[Report Issue](https://github.com/Vishvjeetdahiya/DCRUST/issues)** &nbsp;&bull;&nbsp; **[Creator's Instagram](https://www.instagram.com/vishvjeetdahiyaa)**

</div>

---

## 😫 Why Does This Exist?

Anyone who has tried logging into the university's Samarth portal knows the pain:
- 🐌 Endless spinners and laggy navigation.
- 🔀 Redirect loops just to find the attendance tab.
- 📊 Zero bunk projection — you have to pull out a calculator to figure out if skipping tomorrow's lecture will get you debarred.
- 🔑 Having to re-enter your roll number and password every single time you open your browser.

**This project fixes all of that.** One single click, pure speed, and zero fluff.

---

## 🔥 Killer Features

| Feature | What it does |
| :--- | :--- |
| 🧮 **Bunk / Panic Calculator** | Calculates real-time **safe bunks** (if $\ge 75\%$) or how many **must-attend classes** you need (if $< 75\%$) based on actual semester schedules. |
| ⚡ **Offline Snapshot ("Remember on Device")** | Check attendance once on your phone or laptop. Next time you open the site, your full attendance loads **instantly** without asking for your password. |
| 📅 **Granular Session History** | Expand any subject to see every single class with date, exact timestamp, and `P` / `A` / `L` tags with quick filter pills. |
| 🏎️ **Edge In-Memory Caching** | Cloudflare Worker caches your parsed attendance for 10 minutes. Repeated checks take **~1ms** without touching Samarth servers. |
| 🛡️ **Anti-Abuse Fort** | In-memory lockout (3 failed attempts $\to$ 2-minute cooldown), IP rate limiting (10 req/min), CORS origin lock, and zero password storage anywhere. |
| 🌙 **Clean Dark Mode** | Modern, responsive dark UI built for both smartphones and wide desktop displays with a frosted fixed footer. |
| 🔑 **Forgot Password Shortcut** | One-tap direct link straight to the official DCRUSTM Samarth password reset page. |

---

## 🛠️ Architecture

```
                       ┌────────────────────────┐
                       │   Student's Device     │
                       │  (Phone / Laptop)      │
                       └───────────┬────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              │                                         │
        Cached Snapshot                             Live Check
      (Local Device Storage)                   (POST /attendance)
              │                                         │
              ▼                                         ▼
   ⚡ Instant 0ms Render                     ☁️ Cloudflare Edge Worker
   (Zero password needed)                    ├── Rate Limiting (10 req/min)
                                             ├── 3-Attempt Lockout
                                             ├── 10m Edge SHA-256 Cache
                                             └── Samarth Session Scraper
                                                        │
                                                        ▼
                                             🏛️ Samarth Portal (DCRUSTM)
```

- **Frontend**: Vanilla HTML5 + CSS3 + ES6 JavaScript. No React, no Tailwind, no 50MB `node_modules` — pure lightweight speed, hosted for free on **GitHub Pages**.
- **Backend Edge**: Cloudflare Workers (`worker.js`). Handles session cookie jars, follows SAMARTH CSRF redirects, parses Yii2 GridViews, and streams cleaned JSON.

---

## 🚀 Deploying Your Own

Want to host your own clone? It takes under 3 minutes:

### 1. Deploy the Cloudflare Worker
1. Go to your [Cloudflare Dashboard](https://dash.cloudflare.com/) $\to$ **Workers & Pages** $\to$ **Create Application**.
2. Name it (e.g. `dcrust-attendance`) and click **Deploy**.
3. Click **Edit Code**, delete whatever is there, and paste the contents of [`worker.js`](worker.js).
4. Hit **Save and Deploy**. Copy your worker URL (e.g. `https://your-worker.workers.dev`).

### 2. Configure & Host Frontend
1. Fork or clone this repository.
2. In [`config.js`](config.js), update the worker URL:
   ```javascript
   window.DCRUSTM_WORKER = 'https://your-worker.workers.dev';
   ```
3. Commit and push to `main`.
4. On GitHub, go to **Settings** $\to$ **Pages** $\to$ select branch `main` and folder `/ (root)` $\to$ **Save**.
5. Your custom attendance tracker is live! 🎉

---

## 🔒 Security & Privacy

- **No Database**: Neither your credentials nor your attendance data are stored on any database or external server.
- **Passwords are ephemeral**: Sent through HTTPS directly to the Cloudflare Worker purely to establish the session with Samarth, and immediately discarded.
- **Client Storage**: Only attendance summaries and your roll number are saved to your browser's private `localStorage` for the offline snapshot. Passwords are **never** written to storage.

---

## 👨‍💻 Creator

Crafted with 💗 by **[Vishvjeet Dahiya](https://www.instagram.com/vishvjeetdahiyaa)**

If you found this useful, star ⭐ this repository and share it with your batchmates!


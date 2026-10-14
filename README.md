# Weco — Local Web QA Copilot v1.2.0

> **Deterministic, local-first web quality, accessibility, and multi-page auditor with developer-ready AI fix prompts.**  
> Runs entirely in your browser side panel or floating window. No audit data upload or telemetry. Zero tracking.

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Browser Support](https://img.shields.io/badge/Chrome%20%7C%20Edge-116%2B-green.svg)](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
[![Privacy](https://img.shields.io/badge/Privacy-100%25%20Local--First-brightgreen.svg)](#privacy--security-guarantees)
[![CI Status](https://img.shields.io/badge/CI-Passing%20(78%2B%20checks)-success.svg)](.github/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🌟 Why Weco?

Traditional accessibility and QA checkers either require sending your site's DOM to third-party servers, produce noisy false positives, or only check the static shell of the currently open tab. 

**Weco (Local Web QA Copilot)** was engineered for modern web developers working on dynamic dashboards, SPAs (Next.js, Vite, React, Vue, SvelteKit), and complex multi-page apps:

- **🌐 Site-Wide Dynamic Route Auditing:** Discover and audit linked same-origin routes in a temporary background tab, leaving the page you are using unchanged.
- **↗ Movable Floating Window ("↗ Float"):** Audit your application without altering your browser's responsive viewport width or screen ratio.
- **🔍 Deep Analysis Mode:** Adds ARIA reference integrity and heading hierarchy checks. It detects open shadow-root hosts and reports their internals as an explicit coverage limit.
- **🛡️ 100% Local-First & Zero Telemetry:** Runs strictly inside your browser sandbox. Never sends page content, DOM selectors, or cookies over the internet.
- **🤖 AI-Ready Developer Fix Prompts:** Instantly copies evidence-backed, prompt-injection-safe prompts formatted for Claude, ChatGPT, Gemini, or GitHub Copilot with `<UNTRUSTED_PAGE_DATA>` safety wrappers.
- **📊 Saved Regression Baselines & Diffs:** Save deterministic SHA-256 snapshots of your page's QA health. Rescan after code changes to verify fixed issues and catch new regressions.
- **🎯 Live Interactive Element Highlighter:** Highlights target DOM elements with a non-invasive indicator ring and auto-scrolls to the culprit element (navigating across pages automatically when inspecting multi-page findings).

---

## 🚀 Quick Start & Installation

### 1. Clone or Download the Repository

```bash
git clone https://github.com/hitgoyani/Weco.git
```
*(Or click **Code** → **Download ZIP** on GitHub and extract the folder).*

### 2. Load the Extension in Chrome or Edge

1. Open your browser and navigate to:
   - **Chrome:** `chrome://extensions`
   - **Edge:** `edge://extensions`
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked**.
4. Select the `Weco` project directory (the folder containing `manifest.json`).
5. Pin the extension to your toolbar.

> **Tip for local file testing:** If you want to audit local HTML files (`file:///...`), open extension details in `chrome://extensions` and toggle on **"Allow access to file URLs"**.

---

## 💡 How to Use

### 1. Open the Side Panel or Float Window
- Navigate to any website or local development server (e.g. `http://localhost:3000`).
- Click the **Weco** toolbar icon to open the side panel.
- *Need the full viewport width?* Click **↗ Float** in the top bar to pop the auditor out into an independent utility window that syncs with your browser tabs automatically.

### 2. Choose Your Scan Mode
- **Scan current page:** Conducts a rapid heuristic audit on the active DOM view in under 30ms.
- **🌐 Audit all site pages:** Automatically discovers internal routes (e.g. `/dashboard`, `/dashboard/applications`, `/dashboard/jobs`), audits them in a temporary background tab, and compiles a unified multi-page report. It does not make network requests beyond normal browser navigation, and it excludes obvious logout, delete, and API paths.
- **Deep Analysis mode toggle:** Enables ARIA reference integrity, open Shadow DOM custom element inspection, and additional heading sequence checks.
 
### 3. Filter and Inspect Issues
- Use the **Page Route selector** (in multi-page mode) to filter findings by route.
- Filter by **Category** (Accessibility, Responsive, Functionality, Performance, SEO, Best Practice) or **Severity** (Critical, High, Medium, Low).
- View **Assessment Badges** (`CONFIRMED`, `LIKELY`, `NEEDS REVIEW`) and applicable **WCAG 2.2 Standards** tags on each finding.
- Click **Inspect element** on any finding card: Weco smoothly scrolls your page and highlights the element with an exact viewport-clamped overlay without altering your site's styles.

### 4. Fix with AI or Save Baselines
- **Copy fix prompt:** Copies a focused, evidence-backed prompt for the specific issue.
- **Copy all issues prompt:** Generates a structured multi-page fix plan with untrusted data wrappers ready to paste directly into your AI coding assistant.
- **Save baseline & Compare:** Save snapshots with collision-resistant target identities to track progress across sprints and confirm bug fixes.

---

## 🛡️ What Weco Audits

| Category | Checks & Heuristics |
| :--- | :--- |
| **Accessibility (a11y)** | Missing / whitespace `alt` on images, nameless interactive controls (with weak `title`/`placeholder` fallback warnings), form inputs without detectable labels, focusable elements inside `aria-hidden`, invalid ARIA roles/attributes, positive `tabindex` traps, viewport zoom lockouts, open Shadow DOM custom elements, and small touch targets. Mapped directly to WCAG 2.2 criteria. |
| **Site-Wide Navigation** | Broken in-page fragment links (with percent-encoding decoding), invalid `#` placeholders, broken image resources, legacy named anchors, duplicate DOM element IDs. Route navigation follows normal browser page loads; it does not make HEAD requests or inspect HTTP status codes. |
| **Responsive & Layout** | Horizontal layout overflow (`overflow-x`), culprit container identification, viewport clipping, touch target sizing under 24×24px with explicit review recommendations. |
| **Contrast Analysis** | Solid color contrast evaluation across standard and modern CSS color formats (including `oklch()`, `rgb()`, `hsl()`). Complex/unknown backgrounds and opacity/blending effects are transparently tracked and reported. |
| **Performance & SEO** | Browser Navigation Timing (TTFB, DOM Interactive, DOM Complete) and Paint Timing (First Paint, First Contentful Paint), excessive DOM node counts, script tag saturation, oversized image assets, missing `<title>`, missing meta description, missing responsive viewport. |
| **Security & Best Practice** | Insecure mixed content (HTTP resources on HTTPS pages with individual resource reporting), plaintext password fields on insecure non-local pages, sensitive URL query parameter redaction. |

---

## 🔒 Privacy & Security Guarantees

Weco is built on a **strict local-first architecture**:

1. **No Audit Data Upload:** Weco makes no fetch, XHR, or analytics request to upload page data. A site-wide audit opens the discovered routes in a temporary browser tab, so those pages load normally and may contact their own servers.
2. **Automatic Secret Redaction:** When copying prompts or exporting reports, Weco's privacy engine automatically scrubs:
   - Personal Identification numbers (PAN)
   - JSON Web Tokens (JWT) & bearer tokens
   - AWS API access keys (`AKIA...`)
   - GitHub Personal Access Tokens (`ghp_...`, `gho_...`)
   - Stripe live keys (`sk_live_...`)
   - Credit card numbers (verified with the Luhn algorithm)
   - International & Indian phone numbers
   - Private URL query parameters and auth fragments
3. **Prompt Injection Defense:** All webpage-derived strings (titles, text, attributes, evidence) are quarantined inside strict `<UNTRUSTED_PAGE_DATA>` boundary wrappers with escaped tag delimiters so malicious websites cannot hijack your AI coding agent.
4. **Deterministic Storage:** Saved baselines are hashed with SHA-256 (`crypto.subtle`) and stored locally in browser `chrome.storage.local`.

---

## 🧪 Testing & Verification

Weco includes an automated regression test suite using Playwright and Chromium:

```bash
# 1. Install dev dependencies
python -m pip install -r requirements-dev.txt
python -m playwright install chromium

# 2. Run Privacy & Redaction unit tests
node tests/privacy.test.cjs

# 3. Run Scanner DOM & Rendering regression tests (78+ checks)
python tests/run_regression.py

# 4. Run Side-Panel UI, Multi-Page Crawler & Float window smoke tests
python tests/popup_smoke.py

# 5. Validate JavaScript syntax
node --check background.js privacy.js popup.js scanner.js baselines.js
```

### Try the Test Fixture
You can explore Weco's detection capabilities against a deliberately imperfect test page:

```bash
python -m http.server 8000 --directory tests
```
Open `http://localhost:8000/fixture.html`, open Weco, and click **Scan current page**.

---

## 📁 Repository Structure

```
Weco/
├── manifest.json          # Chrome Extension Manifest V3 configuration
├── background.js          # Service worker for Side Panel management
├── popup.html             # Main auditor UI (side panel & float window)
├── popup.css              # Dark-mode styling, tokens, and responsive layout
├── popup.js               # Multi-page crawler, UI state, filters & export
├── scanner.js             # Live DOM scanner, route discovery & highlight overlay
├── privacy.js             # Privacy engine, token redaction & SHA-256 baseline hashing
├── baselines.html / .js   # Saved baseline manager interface
├── tests/
│   ├── fixture.html       # Deliberately imperfect test page
│   ├── privacy.test.cjs   # Redaction and baseline hashing unit tests
│   ├── run_regression.py  # Playwright regression suite for scanner checks
│   └── popup_smoke.py     # End-to-end side-panel and float window smoke tests
└── .github/workflows/
    └── ci.yml             # GitHub Actions automated CI quality gate
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

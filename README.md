# Local Web QA Copilot v1.2.0

A student-built, local-first Chrome/Chromium Edge side-panel extension inspired by website QA workflows. It is **not the official Floto extension**, uses no Floto branding, and is not affiliated with Floto.

## Install

1. Download and extract `local-web-qa-copilot-v1.2.0.zip`.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Microsoft Edge.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extracted `local-web-qa-copilot` folder — the folder that contains `manifest.json`.
5. Open a normal website and click the extension icon. The tool opens in the browser side panel.
6. Click **Scan current page**.

The extension needs Chrome/Edge 116 or later for the Side Panel API. After installing or updating the extension, **refresh any tab that was already open** before scanning it. This clears any older content-script listener running in that tab. To scan a local `file://` page, open the extension's details and enable **Allow access to file URLs**. Browser-internal pages, extension pages, and the Chrome Web Store cannot be scanned.

## What it checks

- **Accessibility heuristics:** missing/whitespace-only image alternatives, links and controls without a detectable accessible name, visible form controls without detectable labels, focusable descendants of `aria-hidden`, duplicate IDs, empty headings, main landmarks, missing document language, iframe titles, likely invalid ARIA role/attribute usage, positive tabindex, viewport zoom restrictions, and likely small targets.
- **Navigation and functionality signals:** missing in-page fragment targets, legacy named anchors, common `#top` and hash-router patterns, placeholder `href="#"`, broken images, and duplicate IDs.
- **Responsive/layout checks:** horizontal page overflow and small interaction targets at the current viewport.
- **Performance/SEO heuristics:** very large DOMs, many script tags, potentially oversized source images, missing/long title, empty meta description, and missing viewport metadata.
- **Best-practice signals:** HTTP resources referenced by HTTPS pages and password fields visible on non-local HTTP pages.
- **Contrast estimates:** solid colors in browser-supported CSS color syntax, including modern color functions where the browser's canvas parser supports conversion. Unknown/complex backgrounds, some system color combinations, pseudo-elements, opacity/blending effects, and other uncertain cases are skipped instead of being assigned a fabricated ratio.
- **Inspection/reporting:** highlight the selected DOM element with a temporary overlay, copy evidence-aware coding prompts, export a privacy-scrubbed JSON report, and compare against saved local baselines.

Findings are sorted by severity before the display cap. If findings or analysis coverage are limited, the report includes coverage warnings. The numeric score from v1.1.0 was removed because it could imply more accuracy than the rule-based scan supports.

## Try the deliberately imperfect fixture

Start a local web server from the extension root:

```bash
python -m http.server 8000 --directory tests
```

Then open `http://localhost:8000/fixture.html`, click the extension, and scan. The fixture deliberately contains examples such as a nameless button, an image missing `alt`, a missing form label, invalid ARIA, an empty heading, zoom restriction, low-contrast text, a broken fragment, and horizontal overflow. It also includes examples that **should not** be reported as the same problem: an image-only link with alt text, a valid `aria-labelledby` name, a hidden input, `tabindex="-1"` within `aria-hidden`, an inert button, `#top`, hash-router links, and a valid named anchor.

Use **Inspect** on each duplicate-ID finding to confirm that it highlights the correct element. Save a baseline, alter the fixture, refresh, rescan, and compare. Stop the server with `Ctrl+C`.

## Automated regression tests

The tests use a local Chromium engine for the DOM and rendering checks, plus Chrome API stubs for side-panel logic. They are not a substitute for installing the extension in your own Chrome/Edge profile.

Install the Python test dependency if needed:

```bash
python -m pip install playwright
python -m playwright install chromium
```

Run from this folder:

```bash
node tests/privacy.test.cjs
python tests/run_regression.py
python tests/popup_smoke.py
```

The regression suite covers the Claude review's reported classes of problems: URL-key collisions, URL/selector redaction, accessible-name false positives, fragment routing, negative tabindex and inert behavior, CSS color parsing (including `oklch()`), disabled controls, overflow-candidate selection, severity-first truncation, incomplete comparison handling, and same-URL reload invalidation.

## Privacy and permissions

The extension requests `tabs`, `activeTab`, `scripting`, `storage`, `clipboardWrite`, and `sidePanel`; it does not request broad host access and makes no network requests of its own. Page inspection runs after you invoke a scan. Reports are kept in `chrome.storage.session` so the side panel can restore results for the same tab during the browser session. Baselines are saved to extension local storage and can be individually deleted from **Manage baselines**.

Baseline identity is a SHA-256 digest of the exact URL identity (including query state and SPA route fragments where applicable), rather than storing the raw identity as a key. Baseline metadata keeps a scrubbed URL label for readability. Exports and copied prompts drop query values and fragments, strip URL credentials, mask likely opaque/private path segments, and remove CSS ID selectors; however, privacy heuristics cannot recognize every name or secret in every site-specific string. Review reports before sharing them. The report held in extension session storage may contain the full current page URL and evidence, and remains local to the browser profile.

No cloud AI/API integration is included. Copied prompts are intended for a coding agent that can inspect source code separately; this extension itself does not change project files or verify source-code fixes.

## Known limitations — read before relying on findings

- This is a **heuristic first-pass scanner**, not a complete WCAG conformance audit, security audit, performance profile, SEO certification, or substitute for manual testing.
- It does **not currently bundle axe-core**. Accessibility findings are produced by the project's own limited rules; some issues will be missed, and some warnings need human review. Do not infer that an absence of findings means the page is accessible.
- It inspects the current rendered document at one viewport. It does not automatically resize the browser, crawl multiple routes, or fully exercise forms and app workflows.
- It detects open shadow-root hosts and iframe titles, but does not inspect iframe contents or traverse shadow DOM in this version. Closed shadow roots and unloaded lazy content are also outside coverage. Rescan after important UI states appear.
- A scan cannot reliably map a live DOM selector to a source component, infer the true root cause, or prove a code fix worked. Use Playwright/Lighthouse and manual verification for broader testing.
- Some page content, CSSOM, and resource details are restricted by the browser. Cross-origin stylesheets may not be readable; the report warns about incomplete coverage where possible.
- Contrast and small-target findings are estimates/hints. A finding is not proof of a WCAG violation, and no finding is not proof of compliance.
- Baseline comparison is based on category, issue title, and selector. It only lists findings as “no longer detected” when both snapshots are eligible for reliable comparison; even then, absence from a snapshot is not proof that a code change fixed the problem.

## Project files

- `manifest.json`, `background.js` — Manifest V3 and side-panel setup.
- `popup.html`, `popup.css`, `popup.js` — side-panel interface, filters, prompts, export, and baseline comparison.
- `scanner.js` — on-demand DOM scanner and temporary highlight overlay.
- `privacy.js` — shared URL, evidence, selector, and baseline-identity helpers.
- `baselines.html`, `baselines.js` — list and delete saved baselines.
- `tests/fixture.html` — deliberately imperfect page.
- `tests/*.py` and `tests/*.cjs` — automated regression checks.

## v1.2.0 changes

- Moved results from a dismissible action popup to a persistent browser side panel and retained reports in session storage.
- Invalidated reports during same-URL reloads/navigation so stale findings cannot be mistaken for a fresh scan.
- Corrected image-only accessible names, hidden descendant text handling, negative tabindex/inert cases, common fragment conventions, modern CSS color parsing, disabled contrast targets, overflow width measurement, and overflow-candidate selection.
- Reworked URL baseline identities to avoid collisions on long slugs and query values; preserve SPA routes in identity hashes while excluding ordinary page anchors.
- Sanitized shared URLs/resources/selectors, added baseline management, removed the misleading score, sorted by severity before truncation, and introduced coverage warnings and comparison safeguards.
- Added Chromium regression coverage for the issues above.

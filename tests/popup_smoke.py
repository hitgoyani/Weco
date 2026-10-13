#!/usr/bin/env python3
"""Smoke-test the side-panel UI logic using Chrome API stubs (not an extension install test)."""
import asyncio
import re
from pathlib import Path
import shutil
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "popup.html").read_text(encoding="utf-8")
HTML = re.sub(r'<link rel="stylesheet" href="popup\.css">', '', HTML)
HTML = re.sub(r'<script src="(?:privacy|popup)\.js"></script>', '', HTML)


async def main():
    async with async_playwright() as p:
        exe = shutil.which("chromium") or shutil.which("chromium-browser")
        args = {"headless": True, "args": ["--no-sandbox", "--disable-dev-shm-usage"]}
        if exe:
            args["executable_path"] = exe
        browser = await p.chromium.launch(**args)

        # 1. Generate real report from real scanner.js execution (no hardcoded finding ids)
        scanner_page = await browser.new_page()
        await scanner_page.set_content("""
          <!doctype html>
          <html><head><title>Mock QA page</title></head>
          <body>
            <img id="customer-alice" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
            <img id="footer-logo" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
          </body></html>
        """)
        await scanner_page.evaluate("""(() => {
          window.chrome = window.chrome || {};
          Object.defineProperty(window.chrome, 'runtime', {
            value: { onMessage: { addListener(fn) { window.__scannerListener = fn; } } },
            configurable: true
          });
        })()""")
        await scanner_page.add_script_tag(path=str(ROOT / "privacy.js"))
        await scanner_page.add_script_tag(path=str(ROOT / "scanner.js"))
        real_scan_res = await scanner_page.evaluate("""() => new Promise(resolve => {
          window.__scannerListener({type: 'LOCAL_WEB_QA_SCAN'}, {}, resolve);
        })""")
        assert real_scan_res and real_scan_res.get('ok'), real_scan_res
        real_report = real_scan_res['report']
        real_report['url'] = 'https://example.com/mock-qa'
        real_report['title'] = 'Mock QA page'
        # Verify scanner assigned real unique IDs
        assert len(real_report['findings']) >= 2
        assert all(f.get('id') and f['id'].startswith('f-') for f in real_report['findings'])
        finding_ids = {f.get('id') for f in real_report['findings']}
        assert len(finding_ids) == len(real_report['findings'])
        await scanner_page.close()

        # 2. Test side-panel UI with real report
        page = await browser.new_page()
        errors = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        await page.set_content(HTML)
        await page.evaluate("""(report) => {
          window.chrome = window.chrome || {};
          const sessionStore = Object.create(null), localStore = Object.create(null);
          const storageApi = store => ({
            async get(key) {
              if (key === null) return {...store};
              if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, store[k]]).filter(([,v]) => v !== undefined));
              if (typeof key === 'string') return {[key]: store[key]};
              return {};
            },
            async set(items) { Object.assign(store, items); },
            async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; }
          });
          window.__highlightMessages = [];
          window.__permissionGranted = true;
          window.__requestedOrigins = [];
          const tabs = {
            currentUrl: report.url,
            async query() { return [{id: 1, url: this.currentUrl, title: report.title, active: true}]; },
            async get() { return {id: 1, url: this.currentUrl, title: report.title, active: true}; },
            async create() { return {id: 2}; },
            async update(tabId, props) {
              if (props.url) {
                this.currentUrl = props.url;
                setTimeout(() => {
                  if (this.onUpdated?.listener) this.onUpdated.listener(tabId, { status: 'complete', url: props.url });
                }, 10);
              }
              return {id: 1, url: this.currentUrl, title: report.title, active: true};
            },
            async sendMessage(_tabId, message) {
              if (message.type === 'LOCAL_WEB_QA_SCAN') {
                if (window.__sampleReport) {
                  window.__sampleReport.url = this.currentUrl;
                  try { window.__sampleReport.path = new URL(this.currentUrl).pathname; } catch (_) {}
                }
                return {ok: true, report: window.__sampleReport};
              }
              if (message.type === 'LOCAL_WEB_QA_HIGHLIGHT') {
                window.__highlightMessages.push(message);
                return {ok: true};
              }
              return {ok: false, error: 'unsupported test message'};
            },
            onActivated: {addListener(fn) { this.listener = fn; }},
            onUpdated: {addListener(fn) { this.listener = fn; }}
          };
          Object.defineProperty(window.chrome, 'runtime', {value: {getURL: path => 'chrome-extension://test/' + path, getManifest: () => ({version: '1.2.0'})}, configurable: true});
          Object.defineProperty(window.chrome, 'tabs', {value: tabs, configurable: true});
          Object.defineProperty(window.chrome, 'windows', {value: {async getCurrent() { return {id: 1}; }}, configurable: true});
          Object.defineProperty(window.chrome, 'scripting', {value: {async executeScript() { return []; }}, configurable: true});
          Object.defineProperty(window.chrome, 'storage', {value: {session: storageApi(sessionStore), local: storageApi(localStore)}, configurable: true});
          Object.defineProperty(window.chrome, 'permissions', {
            value: {
              async request({ origins }) {
                window.__requestedOrigins = origins;
                return window.__permissionGranted;
              }
            },
            configurable: true
          });
          Object.defineProperty(window.crypto, 'subtle', {
            value: {
              async digest(algo, data) {
                const arr = new Uint8Array(32);
                const src = new Uint8Array(data);
                for (let i = 0; i < src.length; i++) {
                  arr[i % 32] = (arr[i % 32] * 31 + src[i]) & 0xff;
                }
                return arr.buffer;
              }
            },
            configurable: true
          });
          window.__sampleReport = report;
        }""", real_report)
        await page.add_script_tag(path=str(ROOT / "privacy.js"))
        await page.add_script_tag(path=str(ROOT / "popup.js"))
        await page.wait_for_function("document.querySelector('#pageTitle').textContent === 'Mock QA page'")
        await page.click("#scanBtn")
        await page.wait_for_function("document.querySelector('#statusLine').textContent.includes('Scan complete')")
        assert await page.locator(".finding-card").count() >= 2

        # Test Inspect Element button sends LOCAL_WEB_QA_HIGHLIGHT
        await page.locator('button[data-action="inspect"]').first.click()
        highlight_msg = await page.evaluate("() => window.__highlightMessages.pop()")
        assert highlight_msg and highlight_msg.get('type') == 'LOCAL_WEB_QA_HIGHLIGHT', highlight_msg

        # Test Copy fix prompt button updates status line
        await page.locator('button[data-action="copy"]').first.click()
        assert await page.wait_for_function("document.querySelector('#statusLine').textContent.includes('prompt copied')")

        # Test baseline matching: save baseline with 2 distinct #id elements of the same rule
        await page.locator("#saveBaselineBtn").click()
        await page.wait_for_function("document.querySelector('#statusLine').textContent.includes('Baseline saved')")

        # Simulate fixing one of the two findings (#customer-alice fixed, #footer-logo remaining)
        await page.evaluate("""() => {
          window.__sampleReport.findings = window.__sampleReport.findings.filter(f => !f.selector.includes('customer-alice'));
        }""")
        await page.locator("#compareBtn").click()
        await page.wait_for_function("!document.querySelector('#comparePanel').hidden")
        resolved_count = await page.locator(".resolved-count").inner_text()
        assert resolved_count == "1", f"Expected exactly 1 resolved finding, got {resolved_count}"
        kept_count = await page.locator(".compare-stats span:nth-child(3) b").inner_text()
        assert kept_count == str(len(real_report['findings']) - 1), f"Expected {len(real_report['findings']) - 1} kept findings, got {kept_count}"

        # Test permissions flow: denied path
        await page.evaluate("""() => {
          let injected = false;
          window.chrome.scripting.executeScript = async () => {
            throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the host.');
          };
          window.__permissionGranted = false;
        }""")
        await page.click("#scanBtn")
        await page.wait_for_function("document.querySelector('#statusLine').textContent.includes('Permission to inspect this page was not granted')")

        # Test permissions flow: granted path
        await page.evaluate("""() => {
          window.__permissionGranted = true;
          let attempt = 0;
          window.chrome.scripting.executeScript = async () => {
            attempt++;
            if (attempt === 1) throw new Error('Cannot access contents of the page. Host permission required.');
            return [];
          };
        }""")
        await page.click("#scanBtn")
        await page.wait_for_function("document.querySelector('#statusLine').textContent.includes('Scan complete')")

        # Same-URL reload must invalidate the old report and disable scanning until load completes.
        await page.evaluate("""() => window.chrome.tabs.onUpdated.listener(1,
          {status: 'loading'}, {id: 1, url: window.__sampleReport.url, title: 'Mock QA page'})""")
        await page.wait_for_function("document.querySelector('#statusLine').textContent.includes('Page is loading')")
        assert await page.locator('#reportSection').is_hidden()
        assert await page.locator('#scanBtn').is_disabled()
        await page.evaluate("""() => window.chrome.tabs.onUpdated.listener(1,
          {status: 'complete'}, {id: 1, url: window.__sampleReport.url, title: 'Mock QA page'})""")
        await page.wait_for_function("document.querySelector('#statusLine').textContent.includes('Page loaded')")
        assert not await page.locator('#scanBtn').is_disabled()

        # Multi-page site audit: discover and audit linked pages, verify page filter and fix plan
        await page.evaluate("""() => {
          window.__sampleReport.discoveredRoutes = [
            'https://example.com/mock-qa',
            'https://example.com/mock-qa/jobs'
          ];
        }""")
        await page.click("#scanSiteBtn")
        await page.wait_for_function("document.querySelector('#statusLine').textContent.includes('Site audit complete')")
        assert not await page.locator("#pageFilter").is_hidden()
        options = await page.locator("#pageFilter option").all_inner_texts()
        assert any("/mock-qa" in opt for opt in options), options
        assert any("/jobs" in opt for opt in options), options
        status_text = await page.locator("#statusLine").inner_text()
        assert "2 pages audited" in status_text, status_text
        await page.select_option("#pageFilter", value="/mock-qa/jobs")
        assert await page.locator(".finding-card").count() >= 1
        await page.select_option("#pageFilter", value="all")
        fix_plan = await page.evaluate("() => fullFixPlan()")
        assert "multi-page-site-audit" in fix_plan
        assert "/mock-qa/jobs" in fix_plan

        assert not errors, errors
        print("PASS: side-panel state, real scanner IDs, inspect/copy actions, distinct #id baselines, permissions flow, reload invalidation, multi-page site audit.")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())


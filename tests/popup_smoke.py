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

REPORT = {
    "product": "Local Web QA Copilot", "version": "1.2.0",
    "url": "https://example.test/products?state=open&keyword=shoes",
    "origin": "https://example.test", "path": "/products",
    "title": "Mock QA page", "checkedAt": "2026-10-13T00:00:00.000Z",
    "viewport": {"width": 1280, "height": 800, "devicePixelRatio": 1},
    "metrics": {"domElements": 40, "images": 2, "links": 3, "forms": 1, "externalScripts": 0, "scanDurationMs": 11},
    "counts": {"critical": 0, "high": 1, "medium": 0, "low": 0, "info": 0},
    "categories": {"accessibility": 1}, "totalFindings": 1, "displayedFindings": 1,
    "truncated": False, "completeForComparison": True, "coverageWarnings": [],
    "limitations": ["Rule-based first-pass scan."],
    "findings": [{
        "id": "f-1", "category": "accessibility", "severity": "high", "title": "Missing alt text",
        "selector": "#customer-alice@example.com > img", "element": "<img>",
        "description": "Image has no descriptive alt text.", "evidence": "Possible contact alice@example.com; query secret=redacted.",
        "recommendation": "Add appropriate alt text.", "confidence": "high"
    }]
}

async def main():
    async with async_playwright() as p:
        exe = shutil.which("chromium") or shutil.which("chromium-browser")
        args = {"headless": True, "args": ["--no-sandbox", "--disable-dev-shm-usage"]}
        if exe:
            args["executable_path"] = exe
        browser = await p.chromium.launch(**args)
        page = await browser.new_page()
        errors = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        await page.set_content(HTML)
        await page.evaluate("""(report) => {
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
          const tabs = {
            async query() { return [{id: 1, url: report.url, title: report.title, active: true}]; },
            async get() { return {id: 1, url: report.url, title: report.title, active: true}; },
            async create() { return {id: 2}; },
            async sendMessage(_tabId, message) {
              if (message.type === 'LOCAL_WEB_QA_SCAN') return {ok: true, report};
              if (message.type === 'LOCAL_WEB_QA_HIGHLIGHT') return {ok: true};
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
          Object.defineProperty(window.crypto, 'subtle', {value: {async digest() { return new Uint8Array(32).fill(7).buffer; }}, configurable: true});
          window.__sampleReport = report;
        }""", REPORT)
        await page.add_script_tag(path=str(ROOT / "privacy.js"))
        await page.add_script_tag(path=str(ROOT / "popup.js"))
        await page.wait_for_function("document.querySelector('#pageTitle').textContent === 'Mock QA page'")
        await page.click("#scanBtn")
        await page.wait_for_function("document.querySelector('#statusLine').textContent.includes('Scan complete')")
        assert await page.locator(".finding-card").count() == 1
        assert await page.locator("#highCount").inner_text() == "1"
        assert await page.locator("#pageUrl").inner_text() == "example.test/products?state=%5Bvalue+omitted%5D&keyword=%5Bvalue+omitted%5D"

        # Shared/exported data must not expose query values, email addresses or local selector IDs.
        safe = await page.evaluate("sanitizeReportForSharing(window.__sampleReport)")
        safe_blob = str(safe)
        assert "shoes" not in safe_blob and "open" not in safe_blob and "alice@example.com" not in safe_blob
        assert "customer-alice" not in safe_blob

        await page.locator("#searchInput").fill("no such issue")
        await page.wait_for_timeout(220)
        assert await page.locator("#emptyState").is_visible()
        await page.locator("#searchInput").fill("alt text")
        await page.wait_for_timeout(220)
        assert await page.locator(".finding-card").count() == 1

        await page.locator("#saveBaselineBtn").click()
        await page.wait_for_function("document.querySelector('#statusLine').textContent.includes('Baseline saved')")
        await page.locator("#compareBtn").click()
        await page.wait_for_function("!document.querySelector('#comparePanel').hidden")

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
        assert not errors, errors
        print("PASS: side-panel state, reload invalidation, scan flow, severity counts, URL redaction, debounced search, baselines, no JS errors.")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())

#!/usr/bin/env python3
"""Run deterministic scanner regression checks in a real Chromium DOM/rendering engine.

Install the test dependency with:
    python -m pip install playwright
    python -m playwright install chromium
Then run this file from the extension root or this tests folder.
"""
import asyncio
from pathlib import Path
import shutil

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = (ROOT / "tests" / "fixture.html").read_text(encoding="utf-8")


async def main():
    async with async_playwright() as p:
        executable = shutil.which("chromium") or shutil.which("chromium-browser")
        launch_args = {"headless": True, "args": ["--no-sandbox", "--disable-dev-shm-usage"]}
        if executable:
            launch_args["executable_path"] = executable
        browser = await p.chromium.launch(**launch_args)
        page = await browser.new_page(viewport={"width": 390, "height": 800})
        page_errors = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        await page.set_content(FIXTURE, wait_until="load")
        await page.evaluate("""() => {
          const holder = document.createElement('section');
          holder.id = 'contrast-cap-test-holder';
          for (let i = 0; i < 45; i += 1) {
            const p = document.createElement('p');
            p.textContent = 'Low contrast cap candidate ' + i;
            p.style.color = '#999';
            p.style.backgroundColor = '#fff';
            holder.appendChild(p);
          }
          document.body.appendChild(holder);
        }""")
        await page.evaluate("""(() => {
          window.chrome = window.chrome || {};
          Object.defineProperty(window.chrome, 'runtime', {
            value: { onMessage: {
              _listeners: [],
              addListener(fn) { this._listeners.push(fn); },
              removeListener(fn) { this._listeners = this._listeners.filter(item => item !== fn); }
            } }, configurable: true
          });
        })()""")
        await page.add_script_tag(path=str(ROOT / "privacy.js"))
        await page.add_script_tag(path=str(ROOT / "scanner.js"))
        result = await page.evaluate("""async () => await new Promise(resolve =>
          window.__LOCAL_WEB_QA_COPILOT__.listener({type:'LOCAL_WEB_QA_SCAN'}, {}, resolve))""")

        assert result and result.get("ok"), f"Scanner failed: {result}"
        report = result["report"]
        findings = report["findings"]
        titles = [finding["title"] for finding in findings]
        pairs = [(finding["title"], finding["selector"]) for finding in findings]

        def has(title, selector=None):
            return any(f["title"] == title and (selector is None or f["selector"] == selector) for f in findings)

        def matching(title):
            return [f for f in findings if f["title"] == title]

        # Names: include <img alt>, ignore hidden/aria-hidden descendants, preserve ARIA references.
        assert not any(t == "Link has no accessible name" and s == "#image-only-link" for t, s in pairs)
        assert has("Interactive control has no accessible name", "#empty-button")
        assert has("Interactive control has no accessible name", "#hidden-text-button")
        assert not has("Interactive control has no accessible name", "#labelled-by-button")
        assert has("Interactive control has no accessible name", "#labelled-by-hidden-only-button")
        assert not has("Interactive control has no accessible name", "#btn-with-title")
        assert has("Image alternative text is missing or whitespace-only", "#image-without-alt")
        assert has("Form control has no accessible label", "#unlabelled-field")
        assert has("Form control has no accessible label", "#aria-hidden-label-input")
        assert not has("Form control has no accessible label", "#email-field")
        assert not has("Form control has no accessible label", "#contents-field")
        assert not has("Form control has no accessible label", "#hidden-field")
        assert not has("Form control has no accessible label", "#opacity-zero-field")
        assert not has("Form control has no accessible label", "#switch-with-content")
        assert has("Form control has no accessible label", "#switch-without-label")

        # Focus management: -1 and inert subtrees must not be reported as tab-focusable aria-hidden controls.
        focus_findings = matching("Focusable control is inside aria-hidden content")
        focus_elements = {await page.evaluate("s => document.querySelector(s)?.id || ''", f["selector"]) for f in focus_findings}
        assert "hidden-focusable" in focus_elements
        assert "negative-tabindex" not in focus_elements
        assert "inert-button" not in focus_elements

        # Fragment navigation: #top, hash routers and legacy named anchors are valid here.
        fragment_findings = matching("In-page link target was not found")
        assert len(fragment_findings) == 1, fragment_findings
        only_broken_target = await page.evaluate("s => document.querySelector(s)?.getAttribute('href')", fragment_findings[0]["selector"])
        assert only_broken_target == "#missing-destination", only_broken_target

        # Current CSS color syntax, disabled controls and empty headings.
        contrast = matching("Possible low text contrast")
        contrast_elements = {await page.evaluate("s => document.querySelector(s)?.className || ''", f["selector"]) for f in contrast}
        assert any("low-contrast" == c for c in contrast_elements), contrast_elements
        assert any("low-contrast-modern" == c for c in contrast_elements), contrast_elements
        contrast_ids = [await page.evaluate("s => document.querySelector(s)?.id || ''", f["selector"]) for f in contrast]
        assert 'disabled-low-contrast' not in contrast_ids, contrast_ids
        assert not has("Possible low text contrast", "#complex-background")
        assert len(contrast) == 40, f'Contrast report cap expected 40 findings, got {len(contrast)}'
        assert any('additional low-contrast candidates were not listed individually' in warning for warning in report['coverageWarnings'])
        assert has("Heading has no accessible text")
        empty_heading = next(f for f in findings if f["title"] == "Heading has no accessible text")
        assert await page.evaluate("s => document.querySelector(s)?.tagName", empty_heading["selector"]) == "H3"

        # Semantics: flag made-up ARIA, abstract roles, and invalid attribute values, but do not flag a valid doc-* role or menu role.
        assert has("Unknown or invalid ARIA role")
        assert has("Abstract ARIA role must not be used in content", "#abstract-role-element")
        assert has("Invalid ARIA attribute value", "#invalid-token-element")
        assert not any(f["title"] == "Invalid boolean ARIA value" and f["selector"] == "#aria-expanded-undefined-btn" for f in findings)
        invalid_roles = [await page.evaluate("s => document.querySelector(s)?.getAttribute('role') || ''", f["selector"]) for f in matching("Unknown or invalid ARIA role")]
        assert 'doc-chapter' not in invalid_roles, invalid_roles
        assert 'menu' not in invalid_roles, invalid_roles
        assert has("Unrecognized ARIA attribute")
        assert has("Positive tabindex disrupts focus order")
        assert has("Viewport setting may prevent zoom")

        # Layout: culprit selector should resolve to the actual overflowing element, not a random wide node.
        overflow = matching("Horizontal overflow detected")
        assert len(overflow) == 1, overflow
        overflow_class = await page.evaluate("s => document.querySelector(s)?.className || ''", overflow[0]["selector"])
        assert "overflow-box" in overflow_class, (overflow[0]["selector"], overflow_class)
        assert "#wide-contained-table" not in overflow[0]["selector"]
        small_target = matching("Small interactive target")
        assert small_target and all(f["category"] == "accessibility" for f in small_target)

        # No numeric score is emitted; truncation and coverage are explicit.
        assert "score" not in report
        assert report["completeForComparison"] is False  # fixture contains an iframe intentionally
        assert any("iframe" in warning for warning in report["coverageWarnings"])
        assert report["totalFindings"] >= len(findings)
        assert not page_errors, page_errors

        print(f"PASS: {len(findings)} displayed findings from {report['totalFindings']} total.")
        print(f"PASS: scan took {report['metrics']['scanDurationMs']} ms; {len(report['coverageWarnings'])} coverage note(s).")
        print("PASS: accessible names, fragments, contrast (including oklch), contrast cap/unknown-background skip, headings, tabindex, ARIA roles, overflow, and coverage behavior.")

        # Test: body background-image with an opaque white card containing #aaa text must be flagged for low contrast
        await page.evaluate("""() => {
          document.body.style.backgroundImage = 'radial-gradient(circle, #333, #000)';
          const card = document.createElement('div');
          card.id = 'opaque-card-over-bg-image';
          card.style.backgroundColor = '#ffffff';
          const p = document.createElement('p');
          p.id = 'card-low-contrast-text';
          p.style.color = '#aaa';
          p.textContent = 'Low contrast text on opaque card';
          card.appendChild(p);
          document.body.insertBefore(card, document.body.firstChild);
        }""")
        bg_card_result = await page.evaluate("""async () => await new Promise(resolve =>
          window.__LOCAL_WEB_QA_COPILOT__.listener({type:'LOCAL_WEB_QA_SCAN'}, {}, resolve))""")
        assert bg_card_result and bg_card_result.get('ok'), bg_card_result
        card_contrast = [f for f in bg_card_result['report']['findings'] if f['title'] == 'Possible low text contrast']
        card_selectors = [f['selector'] for f in card_contrast]
        assert any('#card-low-contrast-text' in s for s in card_selectors), f'Expected contrast finding on opaque card over background image, got: {card_selectors}'
        await page.evaluate("""() => {
          document.body.style.backgroundImage = '';
          document.getElementById('opaque-card-over-bg-image')?.remove();
        }""")

        # Test: on-node #fff + dark background-image:
        # white text on it must NOT be falsely flagged as low contrast against #fff;
        # dark text on it must be skipped (never falsely passed as readable against #fff).
        await page.evaluate("""() => {
          const container = document.createElement('div');
          container.id = 'bg-image-and-color-test';
          container.style.backgroundColor = '#ffffff';
          container.style.backgroundImage = 'linear-gradient(#000, #111)';
          const pWhite = document.createElement('p');
          pWhite.id = 'white-text-over-bg-image';
          pWhite.style.color = '#ffffff';
          pWhite.textContent = 'White text over dark image';
          container.appendChild(pWhite);
          const pDark = document.createElement('p');
          pDark.id = 'dark-text-over-bg-image';
          pDark.style.color = '#111111';
          pDark.textContent = 'Dark text over dark image';
          container.appendChild(pDark);
          document.body.insertBefore(container, document.body.firstChild);
        }""")
        bg_node_res = await page.evaluate("""async () => await new Promise(resolve =>
          window.__LOCAL_WEB_QA_COPILOT__.listener({type:'LOCAL_WEB_QA_SCAN'}, {}, resolve))""")
        assert bg_node_res and bg_node_res.get('ok')
        node_contrast = [f for f in bg_node_res['report']['findings'] if f['title'] == 'Possible low text contrast']
        node_selectors = [f['selector'] for f in node_contrast]
        assert not any('#white-text-over-bg-image' in s for s in node_selectors), 'White text on node with background-image must not be flagged against background-color'
        assert not any('#dark-text-over-bg-image' in s for s in node_selectors), 'Dark text on node with background-image must be skipped (not evaluated against white)'
        await page.evaluate("""() => document.getElementById('bg-image-and-color-test')?.remove()""")

        # Test: 2000px container at 390px viewport with overflow-x: auto must be reported as the culprit
        await page.set_viewport_size({"width": 390, "height": 844})
        await page.evaluate("""() => {
          const wideBox = document.createElement('div');
          wideBox.id = 'wide-overflow-container';
          wideBox.style.width = '2000px';
          wideBox.style.height = '100px';
          wideBox.style.overflowX = 'auto';
          wideBox.textContent = 'Wide overflowing content';
          document.body.insertBefore(wideBox, document.body.firstChild);
        }""")
        overflow_res = await page.evaluate("""async () => await new Promise(resolve =>
          window.__LOCAL_WEB_QA_COPILOT__.listener({type:'LOCAL_WEB_QA_SCAN'}, {}, resolve))""")
        assert overflow_res and overflow_res.get('ok')
        overflow_findings = [f for f in overflow_res['report']['findings'] if f['ruleId'] == 'overflow-horizontal']
        assert len(overflow_findings) >= 1
        assert '#wide-overflow-container' in overflow_findings[0]['selector'] or 'wide-overflow-container' in overflow_findings[0]['selector'], f"Expected wide container as culprit, got: {overflow_findings[0]['selector']}"
        await page.evaluate("""() => document.getElementById('wide-overflow-container')?.remove()""")
        await page.set_viewport_size({"width": 1280, "height": 720})

        # Test: Route discovery collects same-origin dynamic routes, cleans params/hashes, and ignores destructive/asset/external URLs
        await page.evaluate("""() => {
          const base = document.createElement('base');
          base.id = 'route-test-base';
          base.href = 'https://example.com/test/';
          document.head.appendChild(base);

          const linksHolder = document.createElement('div');
          linksHolder.id = 'route-discovery-test-holder';
          linksHolder.innerHTML = `
            <a href="/dashboard/applications">Applications</a>
            <a href="/dashboard/jobs?utm_source=test&ref=123">Jobs</a>
            <a href="/dashboard/resume#overview">Resume</a>
            <a href="https://other-domain.example.com/external">External</a>
            <a href="/logout">Logout</a>
            <a href="/static/image.png">Image</a>
            <a href="javascript:void(0)">JS link</a>
          `;
          document.body.appendChild(linksHolder);
        }""")
        routes_res = await page.evaluate("""async () => await new Promise(resolve =>
          window.__LOCAL_WEB_QA_COPILOT__.listener({type:'LOCAL_WEB_QA_SCAN'}, {}, resolve))""")
        assert routes_res and routes_res.get('ok')
        discovered = routes_res['report'].get('discoveredRoutes', [])
        assert any('/dashboard/applications' in r for r in discovered), discovered
        assert any('/dashboard/jobs' in r for r in discovered), discovered
        assert any('/dashboard/resume' in r for r in discovered), discovered
        assert not any('utm_source' in r for r in discovered), 'Tracking query params must be stripped from discovered routes'
        assert not any('#overview' in r for r in discovered), 'In-page anchor hash must be stripped from discovered routes'
        assert not any('other-domain.example.com' in r for r in discovered), 'External origin must be excluded'
        assert not any('/logout' in r for r in discovered), 'Logout endpoints must be excluded'
        assert not any('.png' in r for r in discovered), 'Asset endpoints must be excluded'
        await page.evaluate("""() => {
          document.getElementById('route-test-base')?.remove();
          document.getElementById('route-discovery-test-holder')?.remove();
        }""")

        # Regression: many earlier DOM findings must not crowd later high-severity issues out of the cap.
        # Generate 315 duplicate IDs (which caps at 60 and records 255 dropped), plus diverse rules to exceed 300 display limit.
        await page.evaluate("""() => {
          const holder = document.createElement('section');
          holder.id = 'truncation-test-holder';
          for (let i = 0; i < 315; i += 1) {
            const el = document.createElement('div');
            el.id = 'deliberate-duplicate-id';
            el.textContent = 'Repeated id test ' + i;
            holder.appendChild(el);
          }
          // Add findings across diverse rules (each capped at 60) so total recorded findings exceed DISPLAY_LIMIT = 300
          for (let i = 0; i < 60; i += 1) {
            const input = document.createElement('input');
            input.type = 'text';
            input.id = 'unlabelled-stress-' + i;
            holder.appendChild(input);

            const img = document.createElement('img');
            img.id = 'img-stress-' + i;
            holder.appendChild(img);

            const link = document.createElement('a');
            link.href = 'https://example.com/stress/' + i;
            link.id = 'link-stress-' + i;
            holder.appendChild(link);

            const h = document.createElement('h4');
            h.id = 'heading-stress-' + i;
            holder.appendChild(h);

            const btn = document.createElement('button');
            btn.id = 'empty-btn-stress-' + i;
            holder.appendChild(btn);
          }
          for (let i = 0; i < 6; i += 1) {
            const button = document.createElement('button');
            button.id = 'late-high-' + i;
            holder.appendChild(button);
          }
          document.body.appendChild(holder);
        }""")
        overflow_result = await page.evaluate("""async () => await new Promise(resolve =>
          window.__LOCAL_WEB_QA_COPILOT__.listener({type:'LOCAL_WEB_QA_SCAN'}, {}, resolve))""")
        assert overflow_result and overflow_result.get('ok'), overflow_result
        overflow_report = overflow_result['report']
        assert overflow_report['truncated'] is True, overflow_report['totalFindings']
        assert overflow_report['totalFindings'] > len(overflow_report['findings']) == 300
        assert overflow_report['completeForComparison'] is False
        assert any('additional Duplicate ID detected findings were not listed individually' in warning for warning in overflow_report['coverageWarnings'])
        high_buttons = [f for f in overflow_report['findings'] if f['title'] == 'Interactive control has no accessible name']
        assert len(high_buttons) >= 6, f'High-severity findings were omitted by truncation: {len(high_buttons)}'
        assert any('omitted from the displayed report' in warning for warning in overflow_report['coverageWarnings'])
        assert all(f['severity'] in ('critical', 'high') for f in overflow_report['findings'][:6])
        print(f"PASS: severity-first truncation preserved high findings ({len(high_buttons)} in first {len(overflow_report['findings'])}); total={overflow_report['totalFindings']}.")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())

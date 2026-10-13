# Regression tests

Install Playwright and its Chromium build if needed:

```bash
python -m pip install playwright
python -m playwright install chromium
```

Run these from the extension root:

```bash
node tests/privacy.test.cjs
python tests/run_regression.py
python tests/popup_smoke.py
```

- `privacy.test.cjs` checks baseline-key uniqueness and privacy-safe shared URLs/resources/selectors.
- `run_regression.py` runs scanner checks in a Chromium DOM/rendering engine, including a high-priority finding preservation test with more than 300 findings.
- `popup_smoke.py` exercises side-panel logic through Chrome API stubs, including the same-URL reload invalidation behavior.

These tests do not install the unpacked extension into a real Chrome profile and do not prove conformance with WCAG. Also use the manual fixture: start `python -m http.server 8000 --directory tests`, open `http://localhost:8000/fixture.html`, and scan it from the side panel.

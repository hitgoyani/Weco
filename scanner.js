(() => {
  'use strict';

  const VERSION = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()?.version) || '1.2.0';
  const PRIVACY = globalThis.LocalWebQaPrivacy;
  if (!PRIVACY) throw new Error('Privacy helpers were not loaded.');
  const GLOBAL_KEY = '__LOCAL_WEB_QA_COPILOT__';
  const previous = window[GLOBAL_KEY];
  if (previous?.listener) {
    try { chrome.runtime.onMessage.removeListener(previous.listener); } catch (_) {}
  }
  if (previous?.cleanupHighlight) {
    try { previous.cleanupHighlight(); } catch (_) {}
  }

  const DISPLAY_LIMIT = 300;
  const MAX_PER_RULE = 60;
  const MAX_CONTRAST_CANDIDATES = 2400;
  const MAX_CONTRAST_REPORTS = 40;
  const findings = [];
  const seenByRule = new Map();
  const ruleCounts = new Map();
  const droppedByRule = new Map();
  const ruleTitles = new Map();
  const droppedStats = { total: 0, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, categories: {} };
  let truncated = false;
  let styleCache = new WeakMap();
  let visibleCache = new WeakMap();
  let styleVisibilityCache = new WeakMap();
  let activeHighlight = null;
  let canvasContext = null;

  function styleOf(el) {
    let style = styleCache.get(el);
    if (!style) {
      style = getComputedStyle(el);
      styleCache.set(el, style);
    }
    return style;
  }

  function uniqueIdSelector(el) {
    if (!el || !el.id) return '';
    try {
      const candidate = `#${CSS.escape(el.id)}`;
      return document.querySelectorAll(candidate).length === 1 ? candidate : '';
    } catch (_) { return ''; }
  }

  function selectorFor(el) {
    if (!(el instanceof Element)) return 'html';
    const root = el.getRootNode ? el.getRootNode() : null;
    if (root && typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) {
      const host = root.host;
      const hostSel = selectorFor(host);
      const parts = [];
      let node = el;
      while (node && node instanceof Element && node !== host) {
        let part = node.tagName.toLowerCase();
        const idSel = uniqueIdSelector(node);
        if (idSel) part += idSel;
        const parent = node.parentElement;
        if (!idSel && parent) {
          const siblings = Array.from(parent.children).filter(s => s.tagName === node.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = parent;
      }
      return `${hostSel}::shadow > ${parts.join(' > ') || el.tagName.toLowerCase()}`;
    }

    const directId = uniqueIdSelector(el);
    if (directId) return directId;

    const parts = [];
    let node = el;
    while (node && node instanceof Element) {
      let part = node.tagName.toLowerCase();
      const idSel = uniqueIdSelector(node);
      if (idSel) part += idSel;
      const parent = node.parentElement;
      if (!idSel && parent) {
        const siblings = Array.from(parent.children).filter(s => s.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (_) {}
      if (node === document.documentElement) break;
      node = parent;
    }
    return parts.join(' > ') || 'html';
  }

  function fingerprintText(value) {
    // Keep baseline identities local and stable without persisting page text.
    let hash = 0x811c9dc5;
    const text = String(value || '').trim().toLowerCase();
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function stableAncestorMarker(el) {
    for (let node = el?.parentElement; node && node instanceof Element; node = node.parentElement) {
      const testId = node.getAttribute('data-testid') || node.getAttribute('data-test') || node.getAttribute('data-qa');
      if (testId) return `test:${fingerprintText(testId)}`;
      if (node.id && uniqueIdSelector(node)) return `id:${fingerprintText(node.id)}`;
    }
    return `tag:${el?.tagName?.toLowerCase() || 'document'}`;
  }

  function targetKeyForFinding(finding, occurrenceIndex = 0) {
    const el = finding.el;
    if (!(el instanceof Element)) return `${finding.ruleId}|document`;
    const role = (el.getAttribute('role') || el.tagName.toLowerCase()).toLowerCase();
    const name = el.getAttribute('aria-label') || labelledByText(el) || el.getAttribute('title') ||
      visibleNameText(el) || el.getAttribute('name') || el.getAttribute('alt') || '';
    const baseKey = `${finding.ruleId}|${stableAncestorMarker(el)}|${role}|${fingerprintText(name)}`;
    return occurrenceIndex > 0 ? `${baseKey}:occ:${occurrenceIndex}` : baseKey;
  }

  function isWithinInertSubtree(el) {
    for (let node = el; node && node instanceof Element; node = node.parentElement) {
      if (node.hasAttribute('inert') || node.hasAttribute('hidden')) return true;
    }
    return false;
  }

  function styleVisibleThroughAncestors(el) {
    if (styleVisibilityCache.has(el)) return styleVisibilityCache.get(el);
    const checked = [];
    let node = el;
    while (node && node instanceof Element) {
      if (styleVisibilityCache.has(node)) {
        const result = styleVisibilityCache.get(node);
        for (const item of checked) styleVisibilityCache.set(item, result);
        return result;
      }
      const style = styleOf(node);
      const hidden = style.display === 'none' || Number.parseFloat(style.opacity) === 0 ||
        style.contentVisibility === 'hidden' || node.hasAttribute('hidden') || node.hasAttribute('inert');
      if (hidden) {
        styleVisibilityCache.set(node, false);
        for (const item of checked) styleVisibilityCache.set(item, false);
        return false;
      }
      checked.push(node);
      node = node.parentElement;
    }
    for (const item of checked) styleVisibilityCache.set(item, true);
    return true;
  }

  function visible(el) {
    if (!(el instanceof Element) || !el.isConnected) return false;
    if (visibleCache.has(el)) return visibleCache.get(el);
    if (!styleVisibleThroughAncestors(el)) {
      visibleCache.set(el, false);
      return false;
    }

    const style = styleOf(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') {
      visibleCache.set(el, false);
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) {
      if (style.display === 'contents') {
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          const hasVisibleContent = Array.from(range.getClientRects()).some(box => box.width > 0 && box.height > 0);
          visibleCache.set(el, hasVisibleContent);
          return hasVisibleContent;
        } catch (_) {}
      }
      visibleCache.set(el, false);
      return false;
    }
    // Common visually-hidden patterns (screen-reader-only content and clipped 1px boxes).
    const visuallyHidden = rect.width <= 1.5 && rect.height <= 1.5 &&
      (style.clip !== 'auto' || style.clipPath !== 'none' || (style.position === 'absolute' && style.overflow === 'hidden'));
    const result = !visuallyHidden;
    visibleCache.set(el, result);
    return result;
  }

  function compact(value, max = 120) {
    const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function textOf(el, max = 160) {
    const value = (el?.textContent || '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function isAccessibilityExposed(el) {
    if (!(el instanceof Element) || !el.isConnected) return false;
    const selfStyle = styleOf(el);
    if (selfStyle.visibility === 'hidden' || selfStyle.visibility === 'collapse') return false;
    for (let node = el; node && node instanceof Element; node = node.parentElement) {
      if (node.hasAttribute('inert') || node.hasAttribute('hidden')) return false;
      if ((node.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true') return false;
      const s = styleOf(node);
      if (s.display === 'none' || s.contentVisibility === 'hidden') return false;
    }
    return true;
  }

  function semanticVisible(el) {
    if (!isAccessibilityExposed(el)) return false;
    const style = styleOf(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const rect = el.getBoundingClientRect();
    const clippedTiny = rect.width <= 1.5 && rect.height <= 1.5 &&
      (style.clip !== 'auto' || style.clipPath !== 'none' || (style.position === 'absolute' && style.overflow === 'hidden'));
    return !clippedTiny;
  }

  function visibleNameText(el, max = 200) {
    let result = '';
    const seenNodes = new Set();
    function walk(node) {
      if (!node || result.length >= max || seenNodes.has(node)) return;
      seenNodes.add(node);
      if (node !== el && node instanceof Element) {
        const ariaHidden = (node.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true';
        if (ariaHidden || node.hasAttribute('hidden') || node.hasAttribute('inert')) return;
        const s = styleOf(node);
        if (s.display === 'none' || s.contentVisibility === 'hidden') return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const pStyle = node.parentElement ? styleOf(node.parentElement) : null;
        if (pStyle && (pStyle.visibility === 'hidden' || pStyle.visibility === 'collapse')) return;
        result += ` ${node.nodeValue || ''}`;
        return;
      }
      if (!(node instanceof Element)) return;
      const s = styleOf(node);
      if (s.visibility === 'hidden' || s.visibility === 'collapse') return;
      if (node.tagName === 'IMG') {
        result += ` ${node.getAttribute('alt') || ''}`;
        return;
      }
      if (node.tagName === 'INPUT') {
        const type = (node.getAttribute('type') || 'text').toLowerCase();
        if (['button', 'submit', 'reset'].includes(type)) result += ` ${node.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '')}`;
        else if (type === 'image') result += ` ${node.getAttribute('alt') || ''}`;
        else result += ` ${node.value || ''}`;
        return;
      }
      if (node.tagName === 'TEXTAREA') {
        result += ` ${node.value || ''}`;
        return;
      }
      if (node.tagName === 'SELECT') {
        const selected = Array.from(node.selectedOptions || []).map(o => o.text).join(' ');
        result += ` ${selected || node.value || ''}`;
        return;
      }
      if (node.namespaceURI === 'http://www.w3.org/2000/svg') {
        const title = node.querySelector(':scope > title');
        if (title) result += ` ${title.textContent || ''}`;
      }
      for (const child of node.childNodes) walk(child);
    }
    walk(el);
    return result.replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function hasNonEmptyAttr(el, name) {
    return !!(el.getAttribute(name) || '').trim();
  }

  function textFromLabelReference(root, max = 200) {
    let result = '';
    const visited = new Set();
    function walk(node, isReferenceRoot = false) {
      if (!node || result.length >= max || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === Node.TEXT_NODE) {
        result += ` ${node.nodeValue || ''}`;
        return;
      }
      if (!(node instanceof Element)) return;
      // A directly referenced hidden node can provide a name; hidden descendants inside it do not.
      if (!isReferenceRoot) {
        if (node.hasAttribute('hidden') || node.hasAttribute('inert') ||
            (node.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true') return;
        const style = styleOf(node);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || style.contentVisibility === 'hidden') return;
      }
      if (node.tagName === 'IMG') {
        result += ` ${node.getAttribute('alt') || ''}`;
        return;
      }
      if (node.tagName === 'INPUT') {
        const type = (node.getAttribute('type') || 'text').toLowerCase();
        if (['button', 'submit', 'reset'].includes(type)) result += ` ${node.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '')}`;
        else if (type === 'image') result += ` ${node.getAttribute('alt') || ''}`;
        else result += ` ${node.value || ''}`;
        return;
      }
      if (node.tagName === 'TEXTAREA') {
        result += ` ${node.value || ''}`;
        return;
      }
      if (node.tagName === 'SELECT') {
        const selected = Array.from(node.selectedOptions || []).map(o => o.text).join(' ');
        result += ` ${selected || node.value || ''}`;
        return;
      }
      for (const child of node.childNodes) walk(child, false);
    }
    walk(root, true);
    return result.replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function labelledByText(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return '';
    // Hidden IDREF roots are allowed in accessible-name computation, but aria-hidden/hidden children are ignored.
    const labels = ids.map(id => document.getElementById(id)).filter(Boolean).map(root => textFromLabelReference(root)).filter(Boolean);
    return labels.join(' ').trim();
  }

  function hasValidAssociatedLabel(control) {
    if (!control || !control.labels) return false;
    return Array.from(control.labels).some(label => {
      if (!isAccessibilityExposed(label)) return false;
      const text = visibleNameText(label) || (label.getAttribute('aria-label') || '').trim() || labelledByText(label);
      return Boolean(text);
    });
  }

  function getAccessibleNameInfo(el) {
    if (hasNonEmptyAttr(el, 'aria-label')) return { hasName: true, source: 'aria-label', weak: false };
    if (labelledByText(el)) return { hasName: true, source: 'aria-labelledby', weak: false };

    if (el instanceof HTMLInputElement) {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'image') {
        if (hasNonEmptyAttr(el, 'alt')) return { hasName: true, source: 'alt', weak: false };
        if (hasNonEmptyAttr(el, 'title')) return { hasName: true, source: 'title', weak: true };
      }
      if (type === 'submit' || type === 'reset') return { hasName: true, source: 'default', weak: false };
      if (type === 'button') {
        if (String(el.value || '').trim()) return { hasName: true, source: 'value', weak: false };
        if (hasNonEmptyAttr(el, 'title')) return { hasName: true, source: 'title', weak: true };
      }
      if (hasValidAssociatedLabel(el)) return { hasName: true, source: 'label', weak: false };
    }
    if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      if (hasValidAssociatedLabel(el)) return { hasName: true, source: 'label', weak: false };
    }
    if (visibleNameText(el)) return { hasName: true, source: 'content', weak: false };
    if (hasNonEmptyAttr(el, 'title')) return { hasName: true, source: 'title', weak: true };
    return { hasName: false, source: 'none', weak: false };
  }

  function hasAccessibleName(el) {
    return getAccessibleNameInfo(el).hasName;
  }

  function safeResourceUrl(raw) {
    return PRIVACY.safeResourceUrl(raw, location.href);
  }

  function ruleIdFromTitle(title) {
    return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'general-issue';
  }

  const RULE_STANDARDS = {
    'image-alt-missing': ['WCAG 2.2 SC 1.1.1 Non-text Content (Level A)'],
    'link-name-missing': ['WCAG 2.2 SC 2.4.4 Link Purpose (In Context) (Level A)', 'WCAG 2.2 SC 4.1.2 Name, Role, Value (Level A)'],
    'interactive-name-missing': ['WCAG 2.2 SC 4.1.2 Name, Role, Value (Level A)'],
    'accessible-name-title-fallback': ['WCAG 2.2 SC 4.1.2 (Advisory)', 'W3C ARIA APG Accessible Names'],
    'form-control-unlabelled': ['WCAG 2.2 SC 1.3.1 Info and Relationships (Level A)', 'WCAG 2.2 SC 4.1.2 Name, Role, Value (Level A)'],
    'focus-aria-hidden': ['WCAG 2.2 SC 2.4.3 Focus Order (Level A)', 'WAI-ARIA 1.2'],
    'lang-missing': ['WCAG 2.2 SC 3.1.1 Language of Page (Level A)'],
    'meta-title-missing': ['WCAG 2.2 SC 2.4.2 Page Titled (Level A)'],
    'contrast-low': ['WCAG 2.2 SC 1.4.3 Contrast (Minimum) (Level AA)'],
    'target-small': ['WCAG 2.2 SC 2.5.8 Target Size (Minimum) (Level AA - Advisory/Review)'],
    'aria-role-abstract': ['WAI-ARIA 1.2 Section 5.3', 'WCAG 2.2 SC 4.1.2 (Level A)'],
    'aria-role-invalid': ['WAI-ARIA 1.2', 'WCAG 2.2 SC 4.1.2 (Level A)'],
    'aria-attr-unknown': ['WAI-ARIA 1.2'],
    'aria-attr-invalid': ['WAI-ARIA 1.2', 'WCAG 2.2 SC 4.1.2 (Level A)'],
    'aria-tabindex-positive': ['WCAG 2.2 SC 2.4.3 Focus Order (Level A)'],
    'aria-idref-unresolved': ['WCAG 2.2 SC 1.3.1 Info and Relationships (Level A)', 'WAI-ARIA 1.2'],
    'landmark-main-missing': ['WAI-ARIA 1.2 Landmarks (Best Practice)'],
    'heading-no-h1': ['WCAG 2.2 SC 1.3.1 Info and Relationships (Best Practice)'],
    'heading-skipped': ['WCAG 2.2 SC 1.3.1 Info and Relationships (Best Practice)'],
    'heading-no-text': ['WCAG 2.2 SC 1.3.1 Info and Relationships (Level A)'],
    'resource-mixed-http': ['W3C Mixed Content Level 2'],
    'form-password-http': ['NIST SP 800-63B / Transport Layer Security Best Practice'],
    'meta-viewport-zoom': ['WCAG 2.2 SC 1.4.4 Resize Text (Level AA)']
  };

  function add(el, category, severity, title, description, evidence, recommendation, confidence = 'high', extra = {}) {
    const ruleId = extra.ruleId || ruleIdFromTitle(title);
    const ruleKey = extra.dedupeKey ? `${ruleId}:${extra.dedupeKey}` : ruleId;
    let ruleSeen = seenByRule.get(ruleKey);
    if (!ruleSeen) {
      ruleSeen = new WeakSet();
      seenByRule.set(ruleKey, ruleSeen);
    }
    if (el && ruleSeen.has(el)) return;
    if (el) ruleSeen.add(el);

    ruleTitles.set(ruleId, title);
    const count = ruleCounts.get(ruleId) || 0;
    if (count >= MAX_PER_RULE) {
      droppedByRule.set(ruleId, (droppedByRule.get(ruleId) || 0) + 1);
      droppedStats.total += 1;
      droppedStats.counts[severity] = (droppedStats.counts[severity] || 0) + 1;
      droppedStats.categories[category] = (droppedStats.categories[category] || 0) + 1;
      return;
    }
    ruleCounts.set(ruleId, count + 1);

    const assessment = extra.assessment || (confidence === 'high' && (severity === 'critical' || severity === 'high') ? 'confirmed' : (confidence === 'low' ? 'needs-review' : 'likely'));
    const standards = extra.standards || RULE_STANDARDS[ruleId] || [];

    findings.push({
      id: `f-${findings.length + 1}`,
      el, ruleId, category, severity, title,
      element: el ? `<${el.tagName.toLowerCase()}>` : 'document',
      description, evidence: String(evidence || '').slice(0, 260), recommendation,
      confidence, assessment, standards, ...extra
    });
  }

  function getCanvasContext() {
    if (canvasContext) return canvasContext;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    canvasContext = canvas.getContext('2d', { willReadFrequently: true });
    return canvasContext;
  }

  function parseCssColor(input) {
    const value = String(input || '').trim();
    if (!value || value === 'currentColor' || value === 'none') return null;
    try {
      if (window.CSS?.supports && !CSS.supports('color', value)) return null;
      const ctx = getCanvasContext();
      if (!ctx) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#fa13c7';
      const firstSentinel = ctx.fillStyle;
      ctx.fillStyle = value;
      if (ctx.fillStyle === firstSentinel) {
        // Use a second marker so a legitimate color equal to the first marker still parses.
        ctx.fillStyle = '#05d733';
        const secondSentinel = ctx.fillStyle;
        ctx.fillStyle = value;
        if (ctx.fillStyle === secondSentinel) return null;
      }
      ctx.globalAlpha = 1;
      ctx.fillRect(0, 0, 1, 1);
      const pixel = ctx.getImageData(0, 0, 1, 1).data;
      return { rgb: [pixel[0], pixel[1], pixel[2]], alpha: pixel[3] / 255 };
    } catch (_) { return null; }
  }

  function composite(foreground, background, alpha) {
    return foreground.map((value, index) => value * alpha + background[index] * (1 - alpha));
  }

  function initialCanvasColor() {
    const scheme = styleOf(document.documentElement).colorScheme || '';
    const normalized = scheme.trim().toLowerCase();
    if (normalized === 'dark') return [0, 0, 0];
    if (normalized === 'light' || normalized === 'normal' || !normalized) return [255, 255, 255];
    if (normalized.includes('light') && normalized.includes('dark')) {
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      return prefersDark ? [0, 0, 0] : [255, 255, 255];
    }
    return [255, 255, 255]; // Standard browser default canvas is white
  }

  function getEffectiveBackground(el) {
    const chain = [];
    let node = el;
    while (node && node instanceof Element) { chain.unshift(node); node = node.parentElement; }
    let background = initialCanvasColor();
    let hasBackgroundImage = false;
    for (const ancestor of chain) {
      const style = styleOf(ancestor);
      const color = parseCssColor(style.backgroundColor);
      if (color && color.alpha >= 0.999) {
        background = color.rgb;
        hasBackgroundImage = false;
      } else if (color && color.alpha > 0) {
        if (!background || hasBackgroundImage) return null;
        background = composite(color.rgb, background, color.alpha);
      }
      if (style.backgroundImage && style.backgroundImage !== 'none') {
        hasBackgroundImage = true;
      }
    }
    if (hasBackgroundImage) return null;
    return background;
  }

  function hasOpacityLayer(el) {
    let node = el;
    while (node && node instanceof Element) {
      const style = styleOf(node);
      if (Number.parseFloat(style.opacity) < 0.999 || (style.mixBlendMode && style.mixBlendMode !== 'normal')) return true;
      node = node.parentElement;
    }
    return false;
  }

  function luminance(rgb) {
    const values = rgb.map(v => {
      const n = Math.max(0, Math.min(255, v)) / 255;
      return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
  }

  function contrastRatio(fg, bg) {
    const l1 = luminance(fg), l2 = luminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function isLocalHostname(hostname) {
    const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return true;
    if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
    if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
    if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
    const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    return false;
  }

  function isHttpUrl(raw) {
    try {
      const url = new URL(raw, location.href);
      if (url.protocol !== 'http:') return null;
      if (isLocalHostname(url.hostname)) return null;
      return url;
    } catch (_) { return null; }
  }

  function extractHttpUrlsFromSrcset(srcset) {
    const results = [];
    const pattern = /(?:^|,)\s*((?:https?:)?\/\/[^,\s]+)\s*(?:\s+\d+(?:\.\d+)?[wx])?/gi;
    let match;
    while ((match = pattern.exec(String(srcset || '')))) results.push(match[1]);
    return results;
  }

  function collectInsecureResourceCandidates() {
    const candidates = [];
    const inaccessibleStylesheets = [];
    const addCandidate = (el, raw, sourceKind) => {
      if (raw && isHttpUrl(raw)) candidates.push({ el: el || document.documentElement, raw, sourceKind });
    };
    const resourceTags = new Set(['IMG', 'SCRIPT', 'IFRAME', 'AUDIO', 'VIDEO', 'SOURCE', 'TRACK', 'EMBED', 'OBJECT', 'INPUT']);
    for (const el of document.querySelectorAll('[src],[href],[data],[action],[srcset],[poster]')) {
      const tag = el.tagName;
      if (el.hasAttribute('src') && resourceTags.has(tag)) addCandidate(el, el.getAttribute('src'), 'src');
      if (el.hasAttribute('poster') && tag === 'VIDEO') addCandidate(el, el.getAttribute('poster'), 'video poster');
      if (el.hasAttribute('data') && tag === 'OBJECT') addCandidate(el, el.getAttribute('data'), 'data');
      if (el.hasAttribute('action') && tag === 'FORM') addCandidate(el, el.getAttribute('action'), 'form action');
      if (el.hasAttribute('href')) {
        const hrefIsResource = (tag === 'LINK' && /\b(stylesheet|icon|manifest|preload|modulepreload|prefetch)\b/i.test(el.getAttribute('rel') || '')) ||
          (el.namespaceURI === 'http://www.w3.org/2000/svg' && ['image', 'use'].includes(el.localName));
        if (hrefIsResource) addCandidate(el, el.getAttribute('href'), 'href');
      }
      if (el.hasAttribute('srcset')) for (const src of extractHttpUrlsFromSrcset(el.getAttribute('srcset'))) addCandidate(el, src, 'srcset');
    }

    const cssUrlPattern = /url\(\s*(['"]?)(https?:\/\/[^)'"\s]+)\1\s*\)/gi;
    const importPattern = /@import\s+(?:url\(\s*)?(['"])(https?:\/\/[^'"]+)\1\s*\)?/gi;
    const scanCssText = (cssText, owner, sourceKind) => {
      let match;
      while ((match = cssUrlPattern.exec(String(cssText || '')))) addCandidate(owner, match[2], sourceKind);
      while ((match = importPattern.exec(String(cssText || '')))) addCandidate(owner, match[2], sourceKind.replace('url()', 'import'));
    };

    // Inline style attributes are available even when a page's stylesheet CSSOM is restricted.
    for (const el of document.querySelectorAll('[style]')) {
      scanCssText(el.getAttribute('style') || '', el, 'inline CSS url()');
    }

    // Inspect rules that the browser lets this page read, including same-origin linked CSS and @import sheets.
    const visitedSheets = new Set();
    const scanStyleSheet = sheet => {
      if (!sheet || visitedSheets.has(sheet)) return;
      visitedSheets.add(sheet);
      try {
        for (const rule of Array.from(sheet.cssRules || [])) {
          scanCssText(rule.cssText || '', sheet.ownerNode || document.documentElement, 'stylesheet CSS url()');
          if (rule.styleSheet) scanStyleSheet(rule.styleSheet);
        }
      } catch (_) {
        inaccessibleStylesheets.push(sheet.href || '(stylesheet URL unavailable)');
      }
    };
    for (const sheet of Array.from(document.styleSheets || [])) scanStyleSheet(sheet);

    const unique = new Map();
    for (const item of candidates) {
      const key = `${selectorFor(item.el)}|${item.sourceKind}|${safeResourceUrl(item.raw)}`;
      if (!unique.has(key)) unique.set(key, item);
    }
    return { candidates: Array.from(unique.values()), inaccessibleStylesheets };
  }

  function getAllDocumentElements() {
    const elements = [];
    const openShadowRoots = [];
    function traverse(root) {
      const items = root.querySelectorAll('*');
      for (const el of items) {
        if (el.hasAttribute('data-local-web-qa-overlay')) continue;
        elements.push(el);
        if (el.shadowRoot && el.shadowRoot.mode === 'open') {
          openShadowRoots.push(el.shadowRoot);
          traverse(el.shadowRoot);
        }
      }
    }
    traverse(document);
    return { elements, openShadowRoots };
  }

  function sampleAcrossList(list, limit) {
    if (list.length <= limit) return list;
    const sampled = [];
    const used = new Set();
    for (let i = 0; i < limit; i += 1) {
      const index = Math.floor(i * (list.length - 1) / (limit - 1));
      if (!used.has(index)) { used.add(index); sampled.push(list[index]); }
    }
    return sampled;
  }

  function isHashRouterFragment(href) {
    const raw = String(href || '');
    const fragment = raw.startsWith('#') ? raw.slice(1) : raw;
    let decoded = fragment;
    try { decoded = decodeURIComponent(fragment); } catch (_) {}
    return decoded.startsWith('/') || decoded.startsWith('!/') || decoded.startsWith('!') || decoded.includes('?') || decoded.includes('=');
  }

  function fragmentTargetExists(targetId) {
    if (!targetId) return true;
    if (targetId.toLowerCase() === 'top') return true; // Common browser convention.
    let decoded = targetId;
    try { decoded = decodeURIComponent(targetId); } catch (_) {}
    if (document.getElementById(targetId) || document.getElementById(decoded)) return true;
    try {
      if (document.querySelector(`[id="${CSS.escape(targetId)}"]`) || document.querySelector(`[id="${CSS.escape(decoded)}"]`)) return true;
    } catch (_) {}
    return Array.from(document.getElementsByName(targetId)).concat(Array.from(document.getElementsByName(decoded))).some(el => el.tagName === 'A');
  }

  function collectPerformanceMetrics() {
    const data = { measured: {}, supported: false };
    try {
      if (typeof performance !== 'undefined') {
        const navEntries = performance.getEntriesByType?.('navigation');
        const nav = (navEntries && navEntries[0]) || performance.timing;
        if (nav) {
          data.supported = true;
          const dns = (nav.domainLookupEnd && nav.domainLookupStart) ? Math.max(0, Math.round(nav.domainLookupEnd - nav.domainLookupStart)) : null;
          const tcp = (nav.connectEnd && nav.connectStart) ? Math.max(0, Math.round(nav.connectEnd - nav.connectStart)) : null;
          const ttfb = (nav.responseStart && nav.requestStart) ? Math.max(0, Math.round(nav.responseStart - nav.requestStart)) : null;
          const domInteractive = (nav.domInteractive && nav.startTime !== undefined) ? Math.max(0, Math.round(nav.domInteractive - nav.startTime)) : null;
          const domContentLoaded = (nav.domContentLoadedEventEnd && nav.startTime !== undefined) ? Math.max(0, Math.round(nav.domContentLoadedEventEnd - nav.startTime)) : null;
          const loadComplete = (nav.loadEventEnd && nav.startTime !== undefined) ? Math.max(0, Math.round(nav.loadEventEnd - nav.startTime)) : null;

          if (dns !== null) data.measured.dnsMs = dns;
          if (tcp !== null) data.measured.tcpMs = tcp;
          if (ttfb !== null) data.measured.ttfbMs = ttfb;
          if (domInteractive !== null) data.measured.domInteractiveMs = domInteractive;
          if (domContentLoaded !== null) data.measured.domContentLoadedMs = domContentLoaded;
          if (loadComplete !== null) data.measured.loadCompleteMs = loadComplete;
        }

        const paints = performance.getEntriesByType?.('paint') || [];
        for (const p of paints) {
          if (p.name === 'first-paint') data.measured.firstPaintMs = Math.round(p.startTime);
          if (p.name === 'first-contentful-paint') data.measured.firstContentfulPaintMs = Math.round(p.startTime);
        }
      }
    } catch (_) {}
    return data;
  }

  function getHeadingLevel(el) {
    if (/^H[1-6]$/.test(el.tagName)) return Number(el.tagName.slice(1));
    const level = parseInt(el.getAttribute('aria-level'), 10);
    return (level >= 1 && level <= 6) ? level : 2;
  }

  function detectAriaAndSemantics(all) {
    const abstractRoles = new Set([
      'command', 'composite', 'input', 'landmark', 'range', 'roletype',
      'section', 'sectionhead', 'select', 'structure', 'widget', 'window'
    ]);
    const authorAssignableRoles = new Set(('alert alertdialog application article associationlist associationlistitem banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox timer toolbar tooltip tree treegrid treeitem comment mark suggestion graphics-document graphics-object graphics-symbol doc-abstract doc-acknowledgments doc-afterword doc-appendix doc-backlink doc-biblioentry doc-bibliography doc-bookmark doc-chapter doc-colophon doc-conclusion doc-cover doc-credit doc-credits doc-dedication doc-endnote doc-endnotes doc-epigraph doc-epilogue doc-errata doc-example doc-footnote doc-foreword doc-glossary doc-index doc-introduction doc-noteref doc-notice doc-pagebreak doc-pagefooter doc-pageheader doc-pagelist doc-part doc-preface doc-prologue doc-pullquote doc-qna doc-subtitle doc-tip doc-toc').split(/\s+/));
    const knownAria = new Set(('aria-activedescendant aria-atomic aria-autocomplete aria-braillelabel aria-brailleroledescription aria-busy aria-checked aria-colcount aria-colindex aria-colindextext aria-colspan aria-controls aria-current aria-describedby aria-description aria-details aria-disabled aria-dropeffect aria-errormessage aria-expanded aria-flowto aria-grabbed aria-haspopup aria-hidden aria-invalid aria-keyshortcuts aria-label aria-labelledby aria-level aria-live aria-modal aria-multiline aria-multiselectable aria-orientation aria-owns aria-placeholder aria-posinset aria-pressed aria-readonly aria-relevant aria-required aria-roledescription aria-rowcount aria-rowindex aria-rowindextext aria-rowspan aria-selected aria-setsize aria-sort aria-valuemax aria-valuemin aria-valuenow aria-valuetext').split(/\s+/));
    const booleanAria = new Set(['aria-atomic', 'aria-busy', 'aria-disabled', 'aria-expanded', 'aria-grabbed', 'aria-hidden', 'aria-modal', 'aria-multiline', 'aria-multiselectable', 'aria-readonly', 'aria-required', 'aria-selected']);
    const booleanAllowsUndefined = new Set(['aria-expanded', 'aria-selected', 'aria-hidden']);
    const tokenAriaAllowed = {
      'aria-haspopup': new Set(['false', 'true', 'menu', 'listbox', 'tree', 'grid', 'dialog']),
      'aria-invalid': new Set(['false', 'true', 'grammar', 'spelling']),
      'aria-live': new Set(['off', 'polite', 'assertive']),
      'aria-orientation': new Set(['horizontal', 'vertical', 'undefined']),
      'aria-autocomplete': new Set(['none', 'inline', 'list', 'both']),
      'aria-current': new Set(['page', 'step', 'location', 'date', 'time', 'true', 'false', '']),
      'aria-sort': new Set(['none', 'ascending', 'descending', 'other']),
      'aria-pressed': new Set(['true', 'false', 'mixed', 'undefined']),
      'aria-checked': new Set(['true', 'false', 'mixed', 'undefined'])
    };
    for (const el of all) {
      const role = (el.getAttribute('role') || '').trim();
      if (role) {
        const tokens = role.toLowerCase().split(/\s+/).filter(Boolean);
        const hasAbstract = tokens.find(token => abstractRoles.has(token));
        if (hasAbstract) {
          add(el, 'accessibility', 'high', 'Abstract ARIA role must not be used in content', 'Abstract roles (such as command, roletype, structure, widget) are defined in the WAI-ARIA ontology for classification and must not be assigned to elements by authors.', `role attribute contains abstract role "${hasAbstract}".`, 'Replace with an author-assignable ARIA role (such as button, menuitem, or region) or remove the role attribute.', 'high', { ruleId: 'aria-role-abstract' });
        } else if (!tokens.some(token => authorAssignableRoles.has(token))) {
          add(el, 'accessibility', 'medium', 'Unknown or invalid ARIA role', 'The explicit role value is not recognized by this scanner. Role support can vary by browser and accessibility API, so confirm before changing it.', `role attribute contains ${tokens.length ? 'unrecognized role token(s)' : 'no role token'}.`, 'Use a valid WAI-ARIA role appropriate for this element, or remove an unnecessary role.', 'medium', { ruleId: 'aria-role-invalid' });
        }
      }
      for (const attr of Array.from(el.attributes || [])) {
        if (!attr.name.toLowerCase().startsWith('aria-')) continue;
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (!knownAria.has(name)) {
          add(el, 'accessibility', 'medium', 'Unrecognized ARIA attribute', 'The attribute name is not in the standard ARIA attribute set used by this scanner.', `Attribute name: ${name}.`, 'Check the attribute spelling and use a valid WAI-ARIA attribute.', 'medium', { ruleId: 'aria-attr-unknown' });
          continue;
        }
        if (booleanAria.has(name)) {
          const allowed = booleanAllowsUndefined.has(name) ? ['true', 'false', 'undefined'] : ['true', 'false'];
          if (!allowed.includes(value)) {
            add(el, 'accessibility', 'medium', 'Invalid boolean ARIA value', `${name} expects a true/false${booleanAllowsUndefined.has(name) ? ' or undefined' : ''} value.`, `Attribute ${name} has a non-boolean value.`, 'Use aria attribute values exactly as specified by WAI-ARIA.', 'medium', { ruleId: 'aria-attr-invalid', dedupeKey: name });
          }
        } else if (name in tokenAriaAllowed && !tokenAriaAllowed[name].has(value)) {
          add(el, 'accessibility', 'medium', 'Invalid ARIA attribute value', `The value "${attr.value}" is not a recognized token for ${name}.`, `Attribute ${name} has an unrecognized value "${attr.value}".`, `Use one of the allowed tokens: ${Array.from(tokenAriaAllowed[name]).filter(Boolean).join(', ')}.`, 'medium', { ruleId: 'aria-attr-invalid', dedupeKey: name });
        }
      }
      const rawTabIndex = el.getAttribute('tabindex');
      if (rawTabIndex !== null && Number(rawTabIndex) > 0) add(el, 'accessibility', 'medium', 'Positive tabindex disrupts focus order', 'Positive tabindex values can create an unexpected navigation order as the page changes.', 'A positive tabindex value is present.', 'Use tabindex="0" for normal sequential focus or tabindex="-1" for programmatic focus, and rely on DOM order.', 'medium', { ruleId: 'aria-tabindex-positive' });
    }
  }

  function scanPage(options = {}) {
    findings.length = 0;
    seenByRule.clear();
    ruleCounts.clear();
    droppedByRule.clear();
    ruleTitles.clear();
    droppedStats.total = 0;
    droppedStats.counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    droppedStats.categories = {};
    truncated = false;
    styleCache = new WeakMap();
    visibleCache = new WeakMap();
    styleVisibilityCache = new WeakMap();
    const start = performance.now();
    const { elements: all, openShadowRoots } = getAllDocumentElements();
    const title = (document.title || '').trim();
    const lang = (document.documentElement.getAttribute('lang') || '').trim();
    const viewportMeta = document.querySelector('meta[name="viewport"]');
    const descriptionMeta = document.querySelector('meta[name="description"]');
    const coverageWarnings = [];

    if (!lang) add(document.documentElement, 'accessibility', 'medium', 'Document language is missing', 'Screen readers use the document language to select pronunciation rules.', '<html> has no non-empty lang attribute.', 'Set the correct language, for example <html lang="en"> or the appropriate language code.', 'high', { ruleId: 'lang-missing' });
    if (!title) add(document.querySelector('head') || document.documentElement, 'seo', 'high', 'Page title is missing', 'The document has no useful title for browser tabs, bookmarks, and search results.', 'document.title is empty.', 'Add a concise, unique <title> that describes this page.', 'high', { ruleId: 'meta-title-missing' });
    if (title.length > 65) add(document.querySelector('title') || document.documentElement, 'seo', 'low', 'Page title may be too long', 'Title length alone does not determine SEO quality.', `Title length: ${title.length} characters.`, 'Consider a concise title that puts the important words first.', 'low', { ruleId: 'meta-title-long' });
    if (!descriptionMeta || !hasNonEmptyAttr(descriptionMeta, 'content')) add(document.querySelector('head') || document.documentElement, 'seo', 'low', 'Meta description is missing or empty', 'A description may help search engines summarize the page, although search engines can choose other text.', 'No non-empty meta description content found.', 'Add a specific description for this page; avoid duplicates across important pages.', 'medium', { ruleId: 'meta-desc-missing' });
    if (!viewportMeta) add(document.querySelector('head') || document.documentElement, 'responsive', 'medium', 'Viewport meta tag is missing', 'Mobile browsers may use a desktop-sized layout viewport.', 'No meta[name="viewport"] found.', 'For a responsive page, add <meta name="viewport" content="width=device-width, initial-scale=1">.', 'high', { ruleId: 'meta-viewport-missing' });
    if (viewportMeta) {
      const content = (viewportMeta.getAttribute('content') || '').toLowerCase();
      if (/user-scalable\s*=\s*no\b/.test(content) || /maximum-scale\s*=\s*1(?:\.0+)?(?:\s|,|$)/.test(content)) {
        add(viewportMeta, 'accessibility', 'medium', 'Viewport setting may prevent zoom', 'Restricting user zoom can make content difficult or impossible to read for some users.', 'Viewport metadata contains user-scalable=no or maximum-scale=1.', 'Allow pinch zoom; normally use width=device-width, initial-scale=1 without a restrictive maximum scale.', 'high', { ruleId: 'meta-viewport-zoom' });
      }
    }
    if (!Array.from(document.querySelectorAll('main, [role="main"]')).some(semanticVisible)) add(document.body || document.documentElement, 'accessibility', 'low', 'Main landmark was not found', 'A main landmark helps assistive-technology users jump to the primary page content; some compact pages intentionally omit one.', 'No exposed <main> or role="main" landmark found.', 'Wrap the primary content in one meaningful <main> landmark when appropriate.', 'low', { ruleId: 'landmark-main-missing' });

    for (const img of document.querySelectorAll('img')) {
      const alt = img.getAttribute('alt');
      if (!img.hasAttribute('alt') || (alt !== '' && !alt.trim())) {
        add(img, 'accessibility', 'high', 'Image alternative text is missing or whitespace-only', 'Informative images need meaningful alternatives; decorative images should use exactly alt="".', `Image source: ${safeResourceUrl(img.currentSrc || img.src || '(unknown)')}`, 'Add meaningful alt text when the image conveys information, or exactly alt="" when it is decorative.', 'high', { ruleId: 'image-alt-missing' });
      }
      const rect = img.getBoundingClientRect();
      const offscreenLazy = img.loading === 'lazy' && (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > document.documentElement.clientWidth);
      if (img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src) && !offscreenLazy && !/^data:/i.test(img.currentSrc || img.src)) {
        add(img, 'functionality', 'medium', 'Image appears to be broken', 'The image completed with no usable intrinsic width. Blocked requests and custom loading patterns can also cause this result.', `Source: ${safeResourceUrl(img.currentSrc || img.src)}`, 'Verify the image URL, response status, file path, permissions, and network/content-security rules.', 'medium', { ruleId: 'image-broken' });
      }
    }

    for (const link of document.querySelectorAll('a[href]')) {
      const label = visibleNameText(link) || (link.getAttribute('aria-label') || '').trim() || labelledByText(link) || (link.title || '').trim();
      if (visible(link) && !hasAccessibleName(link)) add(link, 'accessibility', 'high', 'Link has no accessible name', 'The link has no detectable visible text or accessible label to explain its destination.', 'The link has no detectable accessible name; destination details are omitted for privacy.', 'Add descriptive link text or a non-empty aria-label/aria-labelledby reference.', 'high', { ruleId: 'link-name-missing' });
      const href = (link.getAttribute('href') || '').trim();
      if (href === '#') add(link, 'functionality', 'low', 'Link points only to #', 'A placeholder link can jump to the top and may indicate unfinished navigation, though applications sometimes intercept it.', `Link text length: ${label.length} character(s).`, 'Use a real destination or a button for an action; if intentionally intercepted, verify keyboard and screen-reader behavior.', 'low', { ruleId: 'link-placeholder' });
      if (href.startsWith('#') && href.length > 1 && !isHashRouterFragment(href)) {
        let targetId = href.slice(1);
        try { targetId = decodeURIComponent(targetId); } catch (_) {}
        if (!fragmentTargetExists(targetId)) add(link, 'functionality', 'medium', 'In-page link target was not found', 'This fragment does not match an element ID or legacy named anchor in the current document.', 'A fragment target was not found; the raw fragment is omitted for privacy.', 'Correct the fragment target or restore the missing destination.', 'medium', { ruleId: 'link-fragment-broken' });
      }
      if (link.target === '_blank' && !/\bnoopener\b/i.test(link.rel) && !/\bnoreferrer\b/i.test(link.rel)) add(link, 'best-practice', 'low', 'New-tab link lacks explicit rel protection', 'Modern browsers generally apply noopener by default, so this is a compatibility/hardening hint rather than proof of a vulnerability.', 'A target="_blank" link has no explicit noopener/noreferrer token.', 'Consider rel="noopener" for clarity and compatibility; add noreferrer only when suppressing the referrer is desired.', 'low', { ruleId: 'link-rel-missing', confidence: 'low', assessment: 'needs-review', standards: ['HTML Living Standard / Legacy Browser Hardening'] });
    }

    const buttonSelector = 'button,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"],summary,[role="button"],[role="menuitem"],[role="option"],[role="tab"],[role="link"]';
    for (const button of document.querySelectorAll(buttonSelector)) {
      if (!visible(button)) continue;
      const nameInfo = getAccessibleNameInfo(button);
      if (!nameInfo.hasName) {
        add(button, 'accessibility', 'high', 'Interactive control has no accessible name', 'A user of assistive technology may not be able to determine what this control does.', `The ${button.tagName.toLowerCase()} control has no detectable accessible name.`, 'Add meaningful visible text, an appropriate non-empty aria-label, a valid aria-labelledby reference, or alt text for image inputs.', 'high', { ruleId: 'interactive-name-missing' });
      } else if (nameInfo.weak && nameInfo.source === 'title') {
        add(button, 'best-practice', 'low', 'Control relies solely on title fallback for accessible name', 'While title provides a fallback accessible name in HTML-AAM, it is not consistently announced across all assistive technologies or touch screen devices.', `The ${button.tagName.toLowerCase()} control relies only on title="${compact(button.getAttribute('title'), 60)}".`, 'Provide visible text, an associated <label>, or an aria-label attribute for more robust accessible naming.', 'medium', { ruleId: 'accessible-name-title-fallback', confidence: 'medium', assessment: 'needs-review' });
      }
    }

    for (const input of document.querySelectorAll('input,select,textarea,[role="checkbox"],[role="switch"],[role="radio"],[role="textbox"],[role="combobox"],[role="searchbox"]')) {
      const type = (input.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      if (!visible(input) || input.matches(':disabled')) continue;
      const role = (input.getAttribute('role') || '').toLowerCase();
      const allowsNameFromContent = ['checkbox', 'switch', 'radio'].includes(role);
      const nameFromContent = allowsNameFromContent ? visibleNameText(input) : '';
      const hasLabel = hasValidAssociatedLabel(input) || !!labelledByText(input) || hasNonEmptyAttr(input, 'aria-label') || hasNonEmptyAttr(input, 'title') || Boolean(nameFromContent);
      if (!hasLabel) add(input, 'accessibility', 'high', 'Form control has no accessible label', 'Placeholder text alone is not a reliable replacement for a persistent accessible name.', `Visible ${input.tagName.toLowerCase()} control; field name omitted for privacy.`, 'Associate a meaningful accessible label with this control (e.g. <label for="…"> exposed to assistive technology), or provide a non-empty aria-label/aria-labelledby.', 'high', { ruleId: 'form-control-unlabelled' });
    }

    const focusableCandidates = document.querySelectorAll('a[href],button,input:not([type="hidden"]),select,textarea,summary,video[controls],audio[controls],area[href],[tabindex],[contenteditable],[role="button"],[role="checkbox"],[role="switch"],[role="link"],[role="menuitem"],[role="tab"]');
    for (const el of focusableCandidates) {
      if (!visible(el) || el.matches(':disabled') || isWithinInertSubtree(el)) continue;
      let ancestor = el;
      let ariaHidden = false;
      while (ancestor && ancestor instanceof Element) {
        if ((ancestor.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true') { ariaHidden = true; break; }
        ancestor = ancestor.parentElement;
      }
      const explicitTabindex = el.hasAttribute('tabindex');
      const tabFocusable = el.tabIndex >= 0;
      const nativeFocusable = el.matches('a[href],button,input:not([type="hidden"]),select,textarea,summary,video[controls],audio[controls],area[href]') && (!explicitTabindex || el.tabIndex >= 0);
      const contentEditable = el.isContentEditable && (!explicitTabindex || el.tabIndex >= 0);
      if (ariaHidden && (nativeFocusable || tabFocusable || contentEditable)) {
        add(el, 'accessibility', 'high', 'Focusable control is inside aria-hidden content', 'This control appears focusable but is hidden from the accessibility tree by aria-hidden="true" on itself or an ancestor.', `Element type: ${el.tagName.toLowerCase()}; explicit tabindex=${explicitTabindex ? el.getAttribute('tabindex') : '(default)'}.`, 'Remove aria-hidden from content that contains interactive controls, or remove the controls from the tab order while the content is hidden.', 'high', { ruleId: 'focus-aria-hidden' });
      }
    }

    const idGroups = new Map();
    for (const el of document.querySelectorAll('[id]')) {
      if (!el.id) continue;
      if (!idGroups.has(el.id)) idGroups.set(el.id, []);
      idGroups.get(el.id).push(el);
    }
    for (const [id, elements] of idGroups.entries()) {
      if (elements.length < 2) continue;
      for (const el of elements) add(el, 'functionality', 'medium', 'Duplicate ID detected', 'IDs are expected to be unique; duplicates can break labels, fragment navigation, and script selectors.', `A duplicate ID occurs ${elements.length} times; its literal value is omitted for privacy.`, 'Give each element a unique ID and update associated labels, fragment links, and scripts.', 'medium', { ruleId: 'duplicate-id' });
    }

    for (const frame of document.querySelectorAll('iframe')) {
      if (visible(frame) && !hasNonEmptyAttr(frame, 'title')) add(frame, 'accessibility', 'medium', 'Embedded frame has no title', 'A descriptive title helps users of assistive technology understand embedded content.', `Embedded frame source: ${safeResourceUrl(frame.getAttribute('src') || '(missing)')}`, 'Add a short, descriptive title attribute to the iframe.', 'medium', { ruleId: 'frame-title-missing' });
    }

    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role~="heading"]')).filter(semanticVisible);
    for (const heading of headings) {
      if (!visibleNameText(heading) && !hasNonEmptyAttr(heading, 'aria-label') && !labelledByText(heading)) add(heading, 'accessibility', 'medium', 'Heading has no accessible text', 'An empty heading can create an unhelpful entry in the document outline.', `Heading level: H${getHeadingLevel(heading)}.`, 'Add descriptive heading text or remove the empty heading if it is unnecessary.', 'medium', { ruleId: 'heading-no-text' });
    }
    if (headings.length && !headings.some(h => getHeadingLevel(h) === 1)) add(headings[0], 'accessibility', 'low', 'Visible heading structure has no H1', 'A primary heading often communicates the topic and structure; absence of H1 alone is not necessarily a WCAG failure.', 'Visible headings exist, but no visible h1 element was found.', 'Consider adding a meaningful primary heading when appropriate.', 'low', { ruleId: 'heading-no-h1' });
    let lastLevel = 0;
    for (const h of headings) {
      const level = getHeadingLevel(h);
      if (lastLevel && level > lastLevel + 1) add(h, 'accessibility', 'low', 'Heading level is skipped', 'Skipping levels can make content structure harder to follow; review the actual hierarchy before changing tags.', `Previous visible heading: H${lastLevel}; current heading: H${level}.`, 'Use a logical heading hierarchy; do not choose heading tags only for visual size.', 'low', { ruleId: 'heading-skipped' });
      lastLevel = level;
    }

    detectAriaAndSemantics(all);

    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const pageWidth = document.documentElement.scrollWidth;
    if (pageWidth > viewportWidth + 4) {
      const overflowers = all.filter(el => {
        if (!visible(el)) return false;
        if (el === document.documentElement || el === document.body) return false;
        const style = styleOf(el);
        if (['hidden', 'clip'].includes(style.overflowX)) return false;
        let ancestor = el.parentElement;
        while (ancestor && ancestor !== document.documentElement && ancestor !== document.body) {
          const ancStyle = styleOf(ancestor);
          if (['auto', 'scroll', 'hidden', 'clip'].includes(ancStyle.overflowX)) {
            return false;
          }
          ancestor = ancestor.parentElement;
        }
        const r = el.getBoundingClientRect();
        // Ignore elements completely off-canvas; a partially visible element can still cause overflow.
        if (r.right <= 0) return false;
        return (r.right > viewportWidth + 3 || r.left < -3) && r.width > 30;
      }).map(el => {
        const r = el.getBoundingClientRect();
        const amount = Math.max(0, r.right - viewportWidth, -r.left);
        return { el, amount, width: r.width, rect: r };
      }).filter(item => item.amount > 3).sort((a, b) => (b.width - a.width) || (b.amount - a.amount));
      const culprit = overflowers[0]?.el || document.documentElement;
      add(culprit, 'responsive', 'high', 'Horizontal overflow detected', 'The document is wider than the usable viewport, which can force horizontal scrolling. Intentional carousels, tables, and maps may be exceptions.', `Usable viewport: ${viewportWidth}px; document scroll width: ${pageWidth}px; largest candidate overhang: ${Math.round(overflowers[0]?.amount || (pageWidth - viewportWidth))}px.`, 'Inspect fixed widths, large images, long unbroken strings, grid/flex children, and missing min-width: 0. Retest at narrower viewports.', 'medium', { viewportWidth, documentWidth: pageWidth, overflowCandidateCount: overflowers.length, ruleId: 'overflow-horizontal' });
    }

    let smallTargets = 0;
    let smallTargetOverflow = 0;
    for (const el of document.querySelectorAll('a[href],button,input,select,textarea,summary,[role="button"],[role="link"]')) {
      if (!visible(el) || el.matches(':disabled')) continue;
      const style = styleOf(el);
      const isInlineTextLink = el.tagName === 'A' && style.display === 'inline' && !el.querySelector('img,svg,button') &&
        el.parentElement && Array.from(el.parentElement.childNodes).some(n => n !== el && n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim().length > 0);
      const hasExplicitSize = el.hasAttribute('style') && (Boolean(el.style.width) || Boolean(el.style.height));
      const isNativeSmallControl = ['checkbox', 'radio'].includes((el.getAttribute('type') || '').toLowerCase()) && style.appearance === 'auto' && !hasExplicitSize;
      if (isInlineTextLink || isNativeSmallControl) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24)) {
        smallTargets += 1;
        if (smallTargets <= 40) add(el, 'accessibility', 'low', 'Small interactive target', 'This target is smaller than 24 by 24 CSS pixels in at least one dimension. WCAG 2.2 SC 2.5.8 includes spacing (24px target spacing), inline, and equivalent control exceptions.', `Rendered size: ${Math.round(r.width)} × ${Math.round(r.height)} CSS px.`, 'Consider enlarging the hit area or providing 24px spacing between targets; verify WCAG 2.2 SC 2.5.8 applicable exceptions.', 'low', { ruleId: 'target-small', confidence: 'low', assessment: 'needs-review', standards: ['WCAG 2.2 SC 2.5.8 Target Size (Minimum) (Level AA - Advisory/Review)'] });
        else smallTargetOverflow += 1;
      }
    }
    if (smallTargetOverflow > 0) coverageWarnings.push(`${smallTargetOverflow} additional small-target candidates were found but not listed individually.`);

    const contrastPool = Array.from(document.querySelectorAll('p,a,button,label,li,h1,h2,h3,h4,h5,h6,small,strong,td,th,legend,summary,span,div,em,b,i,code')).filter(visible);
    const textCandidates = sampleAcrossList(contrastPool, MAX_CONTRAST_CANDIDATES);
    if (contrastPool.length > textCandidates.length) coverageWarnings.push(`Contrast scan sampled ${textCandidates.length} of ${contrastPool.length} candidate elements across the page to keep large-page scans responsive.`);
    let contrastFailuresFound = 0;
    let contrastSkippedComplexBg = 0;
    let contrastSkippedOpacityOrBlend = 0;
    for (const el of textCandidates) {
      const directText = Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim());
      if (!directText || el.matches(':disabled')) continue;
      if (hasOpacityLayer(el)) {
        contrastSkippedOpacityOrBlend += 1;
        continue;
      }
      const style = styleOf(el);
      const fgColor = parseCssColor(style.color);
      const bg = getEffectiveBackground(el);
      if (!bg) {
        contrastSkippedComplexBg += 1;
        continue;
      }
      if (!fgColor) continue;
      const fg = composite(fgColor.rgb, bg, fgColor.alpha);
      const ratio = contrastRatio(fg, bg);
      const size = parseFloat(style.fontSize) || 16;
      const weight = Number.parseInt(style.fontWeight, 10) || (style.fontWeight === 'bold' ? 700 : 400);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      if (ratio < required) {
        contrastFailuresFound += 1;
        if (contrastFailuresFound <= MAX_CONTRAST_REPORTS) add(el, 'accessibility', 'medium', 'Possible low text contrast', 'Computed foreground/background colors appear below the WCAG AA text-contrast threshold. Complex backgrounds, pseudo-elements and blend effects are skipped; verify visually.', `Estimated contrast ${ratio.toFixed(2)}:1; threshold ${required}:1; text content omitted for privacy.`, 'Choose text/background colors with sufficient contrast and verify against the actual rendered background.', 'medium', { contrastRatio: Number(ratio.toFixed(2)), contrastThreshold: required, ruleId: 'contrast-low', standards: ['WCAG 2.2 SC 1.4.3 Contrast (Minimum) (Level AA)'] });
      }
    }
    if (contrastFailuresFound > MAX_CONTRAST_REPORTS) coverageWarnings.push(`${contrastFailuresFound - MAX_CONTRAST_REPORTS} additional low-contrast candidates were not listed individually.`);

    if (all.length > 2500) add(document.body || document.documentElement, 'performance', 'low', 'Potential performance optimization: large DOM', 'A very large DOM can increase style, layout and interaction costs. This is an optimization indicator rather than a measured performance bottleneck.', `${all.length.toLocaleString()} DOM elements found.`, 'Use browser profiling or Lighthouse to measure actual performance impact before simplifying markup.', 'low', { domElementCount: all.length, ruleId: 'dom-large' });
    const externalScriptCount = Array.from(document.scripts).filter(s => s.src).length;
    if (externalScriptCount > 25) add(document.head || document.documentElement, 'performance', 'low', 'Potential performance optimization: many external scripts', 'A high number of script tags can add network and execution overhead. Count alone is an indicator rather than an execution measurement.', `${externalScriptCount} external script tags detected.`, 'Use Lighthouse or browser performance profiling to identify costly resources before changing scripts.', 'low', { externalScriptCount, ruleId: 'script-many' });
    const dpr = window.devicePixelRatio || 1;
    const oversizedImages = Array.from(document.images).filter(img => {
      if (!img.complete || !img.naturalWidth) return false;
      const width = img.getBoundingClientRect().width;
      return width > 0 && img.naturalWidth > Math.max(1600, width * dpr * 2.5);
    }).sort((a, b) => (b.naturalWidth / Math.max(1, b.getBoundingClientRect().width * dpr)) - (a.naturalWidth / Math.max(1, a.getBoundingClientRect().width * dpr)));
    if (oversizedImages.length > 5) coverageWarnings.push(`${oversizedImages.length - 5} additional oversized-image candidates were not listed individually.`);
    for (const img of oversizedImages.slice(0, 5)) {
      add(img, 'performance', 'low', 'Potential performance optimization: oversized source image', 'The selected source is substantially wider than the rendered width even after allowing for device-pixel ratio. It may still be appropriate for zooming or responsive use.', `Intrinsic width: ${img.naturalWidth}px; rendered width: ${Math.round(img.getBoundingClientRect().width)}px; device pixel ratio: ${dpr}.`, 'Check transferred bytes and responsive sources before changing the image.', 'low', { ruleId: 'image-oversized' });
    }

    if (location.protocol === 'https:') {
      const mixedContent = collectInsecureResourceCandidates();
      const insecure = mixedContent.candidates;
      for (const item of insecure.slice(0, 40)) {
        const safeUrl = safeResourceUrl(item.raw);
        add(item.el, 'best-practice', 'medium', 'HTTP resource referenced by HTTPS page', 'A secure page references a resource over unencrypted HTTP. Browsers may block active mixed content; this static check does not confirm that a request succeeded.', `${item.sourceKind} references ${safeUrl}.`, 'Use the HTTPS version of the resource or remove it if no secure version exists.', 'medium', { ruleId: 'resource-mixed-http', dedupeKey: `${item.sourceKind}:${safeUrl}`, resourceUrl: safeUrl, sourceKind: item.sourceKind, standards: ['W3C Mixed Content Level 2'] });
      }
      if (insecure.length > 40) coverageWarnings.push(`${insecure.length - 40} additional mixed-content candidates were not listed individually.`);
      if (mixedContent.inaccessibleStylesheets.length) coverageWarnings.push(`${mixedContent.inaccessibleStylesheets.length} stylesheet(s) could not be inspected for CSS url() references because browser access restrictions apply.`);
    } else if (location.protocol === 'http:' && !isLocalHostname(location.hostname)) {
      const password = document.querySelector('input[type="password"]:not(:disabled)');
      if (password && visible(password)) add(password, 'best-practice', 'critical', 'Password field is displayed on an insecure HTTP page', 'Data sent from a public HTTP page is not protected by HTTPS in transit; authentication pages should use secure transport.', 'A visible password field is present on a non-local HTTP origin. No input values are read.', 'Serve authentication and sensitive forms over HTTPS, redirect HTTP to HTTPS, and configure secure cookies.', 'high', { ruleId: 'form-password-http' });
    }

    if (options.deep) {
      for (const el of all) {
        for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns']) {
          const val = (el.getAttribute(attr) || '').trim();
          if (!val) continue;
          const ids = val.split(/\s+/).filter(Boolean);
          for (const id of ids) {
            if (!document.getElementById(id)) {
              add(el, 'accessibility', 'high', 'Unresolved ARIA ID reference', `Attribute ${attr} references id "${id}", which does not exist in the DOM.`, `Referenced ID "${id}" is missing.`, `Ensure the element with id="${id}" exists or update ${attr}.`, 'high', { ruleId: 'aria-idref-unresolved', dedupeKey: `${attr}:${id}` });
            }
          }
        }
      }
      const headings = all.filter(el => /^H[1-6]$/.test(el.tagName) && visible(el));
      let lastLevel = 0;
      for (const h of headings) {
        const level = Number(h.tagName.slice(1));
        if (lastLevel > 0 && level > lastLevel + 1) {
          add(h, 'accessibility', 'low', 'Heading level skipped', `Heading level jumps from <h${lastLevel}> to <h${level}>, skipping an intermediate level.`, `Heading level ${level} follows ${lastLevel}.`, `Nest headings sequentially (e.g. <h2> before <h3>) to maintain document hierarchy.`, 'low', { ruleId: 'heading-skipped' });
        }
        lastLevel = level;
      }
    }

    const openShadowHosts = openShadowRoots.length;
    const iframeCount = document.querySelectorAll('iframe').length;
    if (openShadowHosts > 0) coverageWarnings.push(`${openShadowHosts} open shadow root(s) inspected for DOM and accessibility rules.`);
    if (iframeCount > 0) coverageWarnings.push(`The scan checks iframe titles but does not inspect the contents of ${iframeCount} iframe(s).`);
    coverageWarnings.push('This is a point-in-time DOM snapshot. Lazy content that has not loaded, closed shadow roots and cross-origin frame contents are outside its coverage. Rescan after important UI states appear.');

    for (const [ruleId, dropped] of droppedByRule.entries()) {
      const ruleName = ruleTitles.get(ruleId) || ruleId;
      coverageWarnings.push(`${dropped} additional ${ruleName} findings were not listed individually.`);
    }

    const severityRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    findings.sort((a, b) => (severityRank[a.severity] ?? 5) - (severityRank[b.severity] ?? 5) || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
    const totalFindings = findings.length + droppedStats.total;
    truncated = findings.length > DISPLAY_LIMIT;
    if (truncated) coverageWarnings.push(`${findings.length - DISPLAY_LIMIT} lower-priority findings were omitted from the displayed report.`);

    // Stage 1: Calculate counts and categories from ALL findings
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    const categories = {};
    for (const f of findings) {
      counts[f.severity] = (counts[f.severity] || 0) + 1;
      categories[f.category] = (categories[f.category] || 0) + 1;
    }
    for (const [sev, c] of Object.entries(droppedStats.counts)) {
      counts[sev] = (counts[sev] || 0) + c;
    }
    for (const [cat, c] of Object.entries(droppedStats.categories)) {
      categories[cat] = (categories[cat] || 0) + c;
    }

    // Stage 2: Only generate selectors and targetKeys for findings in displayed/exported report
    const targetSlice = options.fullExport ? findings : findings.slice(0, DISPLAY_LIMIT);
    const targetKeyOccurrenceMap = new Map();
    for (const f of targetSlice) {
      if (!f.selector) {
        f.selector = f.el ? selectorFor(f.el) : 'html';
      }
      const rawBase = targetKeyForFinding(f, 0);
      const occ = targetKeyOccurrenceMap.get(rawBase) || 0;
      targetKeyOccurrenceMap.set(rawBase, occ + 1);
      f.targetKey = occ > 0 ? `${rawBase}:occ:${occ}` : rawBase;
    }
    for (const f of findings) {
      delete f.el;
    }
    const displayedFindings = targetSlice.slice(0, DISPLAY_LIMIT);

    const rawHash = location.hash || '';
    let isHashAnchor = false;
    let isClientRoute = false;
    if (rawHash && rawHash !== '#' && rawHash.toLowerCase() !== '#top') {
      let targetId = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
      try { targetId = decodeURIComponent(targetId); } catch (_) {}
      let anchorEl = null;
      try {
        anchorEl = targetId ? (document.getElementById(targetId) || document.querySelector(`a[name="${CSS.escape(targetId)}"]`)) : null;
      } catch (_) {}
      if (anchorEl) {
        isHashAnchor = true;
      } else if (rawHash.startsWith('#/') || rawHash.startsWith('#!') || rawHash.length > 1) {
        isClientRoute = true;
      }
    }

    function normalizeRouteUrl(href) {
      try {
        const baseUri = document.baseURI || location.href;
        const u = new URL(href, baseUri);
        const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'];
        for (const param of trackingParams) u.searchParams.delete(param);
        if (u.hash && !u.hash.startsWith('#/') && !u.hash.startsWith('#!')) {
          u.hash = '';
        }
        if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
          u.pathname = u.pathname.slice(0, -1);
        }
        return u.href;
      } catch (_) {
        return null;
      }
    }

    function collectDiscoveredRoutes() {
      const baseUri = document.baseURI || location.href;
      let origin = location.origin;
      try {
        if ((!origin || origin === 'null') && baseUri) {
          const parsedBase = new URL(baseUri);
          if (parsedBase.origin && parsedBase.origin !== 'null') origin = parsedBase.origin;
        }
      } catch (_) {}

      const routes = new Set();
      const current = normalizeRouteUrl(location.href);
      if (current) routes.add(current);

      const linkCandidates = document.querySelectorAll('a[href], [data-href], [data-route], [data-to]');
      for (const el of linkCandidates) {
        if (routes.size >= 60) break;
        const raw = el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-route') || el.getAttribute('data-to');
        if (!raw) continue;
        const trimmed = String(raw).trim();
        if (!trimmed || trimmed === '#' || trimmed.toLowerCase().startsWith('#top') || /^javascript:/i.test(trimmed) || /^mailto:/i.test(trimmed) || /^tel:/i.test(trimmed)) continue;
        try {
          const u = new URL(trimmed, baseUri);
          if (origin && origin !== 'null' && u.origin !== origin) continue;
          if (!['http:', 'https:'].includes(u.protocol)) continue;
          if (/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|tar|mp4|webm|mp3|wav|css|js|map|json|xml|txt)$/i.test(u.pathname)) continue;
          if (/\/(log-?out|sign-?out|delete|auth\/signout|api\/)/i.test(u.pathname)) continue;

          for (const key of Array.from(u.searchParams.keys())) {
            if (PRIVACY.isSensitiveParam(key)) u.searchParams.delete(key);
          }
          const normalized = normalizeRouteUrl(u.href);
          if (normalized) routes.add(normalized);
        } catch (_) {}
      }
      return Array.from(routes);
    }

    const reportComplete = !truncated && droppedStats.total === 0;
    const hasCoverageLimitations = openShadowHosts > 0 || iframeCount > 0 || contrastPool.length > textCandidates.length || coverageWarnings.some(w => /not audited|does not inspect|not listed individually|sampled|iframe\(s\)|stylesheet\(s\).*could not be inspected/i.test(w));
    const coverageStatus = hasCoverageLimitations ? 'partial' : 'full';
    const comparisonReliability = (!reportComplete || hasCoverageLimitations) ? (reportComplete ? 'provisional' : 'review-required') : 'high';
    const completeForComparison = reportComplete && coverageStatus === 'full';

    return {
      product: 'Local Web QA Copilot',
      version: VERSION,
      url: location.href,
      safeUrl: safeResourceUrl(location.href),
      origin: location.origin,
      path: location.pathname,
      title: document.title || '(untitled page)',
      checkedAt: new Date().toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: dpr },
      isHashAnchor,
      isClientRoute,
      discoveredRoutes: collectDiscoveredRoutes(),
      performance: collectPerformanceMetrics(),
      metrics: {
        domElements: all.length, images: document.images.length, links: document.links.length,
        forms: document.forms.length, externalScripts: externalScriptCount,
        iframes: iframeCount, openShadowRoots: openShadowHosts,
        openShadowRootsAudited: openShadowHosts,
        contrastCandidates: contrastPool.length, contrastCandidatesChecked: textCandidates.length,
        contrastSampledOut: Math.max(0, contrastPool.length - textCandidates.length),
        contrastSkippedComplexBg, contrastSkippedOpacityOrBlend,
        contrastFailuresDetected: contrastFailuresFound, smallTargetCandidates: smallTargets,
        smallTargetOverflow,
        scanDurationMs: Math.round(performance.now() - start)
      },
      counts, categories, findings: displayedFindings,
      totalFindings, displayedFindings: displayedFindings.length,
      truncated,
      reportComplete,
      coverageStatus,
      comparisonReliability,
      completeForComparison,
      coverageWarnings,
      limitations: [
        'This is a rule-based first-pass scan, not a complete WCAG, SEO, performance, security, or functional audit.',
        'Only deterministic evidence-backed checks are treated as findings; contrast, size, and layout suggestions can still need manual review.',
        'No page data is sent to a server by this extension. Review exports before sharing because DOM selectors can contain page-specific identifiers.',
        'Use Playwright/Lighthouse and manual keyboard/screen-reader testing for broader validation.'
      ]
    };
  }

  function removeHighlight() {
    if (!activeHighlight) return;
    const item = activeHighlight;
    activeHighlight = null;
    clearTimeout(item.timer);
    window.removeEventListener('scroll', item.update, true);
    window.removeEventListener('resize', item.update, true);
    if (item.host?.isConnected) item.host.remove();
  }

  function highlight(selector) {
    let el;
    try { el = document.querySelector(selector); } catch (_) { return { ok: false, error: 'Invalid element selector.' }; }
    if (!el) return { ok: false, error: 'This element could not be found. It may have changed since the scan.' };
    removeHighlight();
    const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const host = document.createElement('div');
    host.setAttribute('data-local-web-qa-overlay', 'true');
    host.setAttribute('aria-hidden', 'true');
    const shadow = host.attachShadow({ mode: 'closed' });
    const frame = document.createElement('div');
    const transitionStyle = prefersReducedMotion ? 'none' : 'top .06s linear,left .06s linear,width .06s linear,height .06s linear';
    frame.style.cssText = `position:fixed;box-sizing:border-box;border:3px solid #7c5cff;outline:2px solid rgba(255,255,255,.9);outline-offset:2px;border-radius:4px;box-shadow:0 0 0 6px rgba(124,92,255,.22);pointer-events:none;z-index:2147483647;transition:${transitionStyle};`;
    shadow.appendChild(frame);
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    document.documentElement.appendChild(host);
    const update = () => {
      if (!el.isConnected || !host.isConnected) { removeHighlight(); return; }
      const rect = el.getBoundingClientRect();
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const visibleLeft = Math.max(0, rect.left);
      const visibleTop = Math.max(0, rect.top);
      const visibleRight = Math.min(viewportW, rect.right);
      const visibleBottom = Math.min(viewportH, rect.bottom);
      const visibleWidth = Math.max(0, visibleRight - visibleLeft);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);
      frame.style.top = `${visibleTop}px`;
      frame.style.left = `${visibleLeft}px`;
      frame.style.width = `${visibleWidth}px`;
      frame.style.height = `${visibleHeight}px`;
    };
    activeHighlight = { host, update, timer: setTimeout(removeHighlight, 5200) };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update, true);
    el.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'center', inline: 'center' });
    update();
    return {
      ok: true,
      visibleRect: {
        top: frame.style.top,
        left: frame.style.left,
        width: frame.style.width,
        height: frame.style.height
      }
    };
  }

  function waitForDomQuiet(maxMs = 600, quietMs = 150) {
    return new Promise(resolve => {
      let quietTimer = null;
      const timeout = setTimeout(done, maxMs);
      let observer;
      function done() {
        clearTimeout(timeout);
        if (quietTimer) clearTimeout(quietTimer);
        if (observer) observer.disconnect();
        resolve();
      }
      try {
        observer = new MutationObserver(mutations => {
          const isOverlay = mutations.every(m => m.target?.nodeType === Node.ELEMENT_NODE && m.target.hasAttribute?.('data-local-web-qa-overlay'));
          if (isOverlay) return;
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(done, quietMs);
        });
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        quietTimer = setTimeout(done, quietMs);
      } catch (_) { done(); }
    });
  }

  const listener = (message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    if (sender?.id && typeof chrome !== 'undefined' && chrome.runtime?.id && sender.id !== chrome.runtime.id) {
      return false;
    }
    const validTypes = ['LOCAL_WEB_QA_SCAN', 'LOCAL_WEB_QA_HIGHLIGHT', 'LOCAL_WEB_QA_PING'];
    if (!validTypes.includes(message.type)) return false;

    if (message.type === 'LOCAL_WEB_QA_PING') {
      sendResponse({ ok: true, version: VERSION });
      return false;
    }
    if (message.type === 'LOCAL_WEB_QA_HIGHLIGHT') {
      const sel = typeof message.selector === 'string' ? message.selector.slice(0, 1000) : '';
      try { sendResponse(highlight(sel)); }
      catch (error) { sendResponse({ ok: false, error: error?.message || 'Could not highlight the element.' }); }
      return false;
    }
    (async () => {
      try {
        const options = (message.options && typeof message.options === 'object') ? message.options : {};
        if (options.quick !== true && options.settled !== false) {
          await waitForDomQuiet(options.maxWaitMs || 600, options.quietMs || 150);
        }
        const report = scanPage(options);
        sendResponse({ ok: true, report });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || 'Unknown scan error.' });
      }
    })();
    return true;
  };

  chrome.runtime.onMessage.addListener(listener);
  window[GLOBAL_KEY] = { version: VERSION, listener, cleanupHighlight: removeHighlight };
})();

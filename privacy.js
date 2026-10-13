(() => {
  'use strict';

  const SENSITIVE_KEYS = new Set([
    'token', 'accesstoken', 'refreshtoken', 'idtoken', 'secret', 'clientsecret',
    'password', 'passwd', 'auth', 'authorization', 'session', 'sessionid', 'sid',
    'code', 'oauthstate', 'state', 'key', 'apikey', 'accesskey', 'authcode',
    'authorizationcode', 'accesscode', 'resetcode', 'credential', 'credentials',
    'email', 'phone', 'phonenumber', 'mobile', 'telephone', 'signature', 'sig',
    'jwt', 'user', 'userid', 'username', 'account', 'accountid', 'customer',
    'customerid', 'invite', 'invitecode', 'verify', 'verification',
    'verificationcode', 'reset', 'nonce', 'ticket', 'assertion', 'otp',
    'cookie', 'csrf', 'xsrf', 'sessiontoken', 'magiclink'
  ]);

  const IDENTIFIER_PATH_SEGMENTS = new Set([
    'user', 'users', 'member', 'members', 'profile', 'profiles', 'account',
    'accounts', 'customer', 'customers', 'order', 'orders', 'invoice',
    'invoices', 'session', 'sessions', 'reset', 'verify', 'verification',
    'invite', 'invites', 'token', 'auth', 'authorization', 'download',
    'workspace', 'workspaces', 'repo', 'repos', 'repository', 'repositories',
    'org', 'orgs', 'organization', 'organizations', 'tenant', 'tenants'
  ]);

  function normalizeParamName(key) {
    return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function isSensitiveParam(key) {
    const normalized = normalizeParamName(key);
    return SENSITIVE_KEYS.has(normalized) || /^(access|refresh|id)?tokenvalue$/.test(normalized);
  }

  function decodeURIComponentSafe(value) {
    try { return decodeURIComponent(value); } catch (_) { return value; }
  }

  function looksLikeOpaqueToken(segment) {
    const decoded = decodeURIComponentSafe(String(segment || ''));
    if (decoded.length < 36 || decoded.includes('-') || !/^[A-Za-z0-9_]+$/.test(decoded)) return false;
    if (!/[A-Z]/.test(decoded) || !/[a-z]/.test(decoded) || !/\d/.test(decoded)) return false;
    return new Set(decoded).size >= 16;
  }

  function isLuhnValid(digitsStr) {
    const digits = String(digitsStr || '').replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let shouldDouble = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let digit = parseInt(digits.charAt(i), 10);
      if (shouldDouble) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
    }
    return sum % 10 === 0;
  }

  function safeTextForSharing(value) {
    if (!value) return '';
    let text = String(value);

    text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email omitted]');

    const dates = [];
    text = text.replace(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\b/g, m => {
      dates.push(m);
      return `__QA_DATE_${dates.length - 1}__`;
    });

    // PAN (5 letters, 4 digits, 1 letter)
    text = text.replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, '[opaque token omitted]');

    // AWS access keys (AKIA/ASIA + 16 chars)
    text = text.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[opaque token omitted]');

    // GitHub tokens
    text = text.replace(/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{36,}\b/g, '[opaque token omitted]');

    // Full JWT shape (three base64url segments starting with standard eyJ)
    text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[opaque token omitted]');

    // IBANs (2 letters, 2 digits, then 11-30 alphanumeric characters, optional spaces)
    text = text.replace(/\b[A-Z]{2}\d{2}(?:[ \t]?[A-Z0-9]{4}){2,7}(?:[ \t]?[A-Z0-9]{1,4})?\b/g, match => {
      const clean = match.replace(/[\s\t]/g, '');
      if (clean.length >= 15 && clean.length <= 34 && /[A-Z]/.test(clean.slice(4))) {
        return '[number omitted]';
      }
      return match;
    });

    // Payment card numbers with Luhn check
    text = text.replace(/\b(?:\d[ -]?){13,19}\b/g, match => {
      const digitsOnly = match.replace(/\D/g, '');
      if (digitsOnly.length >= 13 && digitsOnly.length <= 19 && isLuhnValid(digitsOnly)) {
        return '[number omitted]';
      }
      return match;
    });

    // International phone numbers with explicit leading '+'
    text = text.replace(/\+\d{1,3}[\s.-]?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{3,5}\b/g, match => {
      const digitsOnly = match.replace(/\D/g, '');
      if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
        return '[number omitted]';
      }
      return match;
    });

    // Formatted US/standard phones with parentheses or hyphens (e.g. (555) 123-4567 or 555-123-4567)
    text = text.replace(/\b(?:\(\d{3}\)|\d{3}-)\s*\d{3}-\d{4}\b/g, '[number omitted]');

    // Numbers preceded by context words (phone, call, mobile, tel, cell, contact, card, account, dial, sms)
    text = text.replace(/(^|[^\w])(phone|call|mobile|tel|cell|contact|card|account|dial|sms)\b([\s:#-]*(?:at\s+)?)((?:\d[ -]?){7,19}\d|\d{10,18})\b/gi, (match, prefix, contextWord, separator, number) => {
      return `${prefix}${contextWord}${separator}[number omitted]`;
    });

    // Long opaque tokens and hashes
    text = text.replace(/\b(?:Bearer\s+[A-Za-z0-9._~+/-]+=*|[A-Za-z0-9_-]{32,})\b/g, token => {
      if (/^Bearer\s+/i.test(token)) return '[opaque token omitted]';
      if (/^[a-fA-F0-9]{32,}$/.test(token)) return '[opaque token omitted]';
      if (token.length >= 40) {
        if (/\d/.test(token)) {
          if (token.includes('_') || !token.includes('-')) {
            return '[opaque token omitted]';
          }
          const parts = token.split('-');
          if (parts.some(p => /[a-zA-Z]/.test(p) && /\d/.test(p))) {
            return '[opaque token omitted]';
          }
        }
      }
      return token;
    });

    text = text.replace(/__QA_DATE_(\d+)__/g, (_, idx) => dates[Number(idx)]);
    return text;
  }

  function safePathname(pathname) {
    const parts = String(pathname || '/').split('/');
    let lastWasRedactedUnderScope = false;
    return parts.map((part, index) => {
      const decoded = decodeURIComponentSafe(part);
      const previous = decodeURIComponentSafe(parts[index - 1] || '').toLowerCase();
      const normalized = decoded.toLowerCase();
      if (!decoded) return part;
      if (IDENTIFIER_PATH_SEGMENTS.has(previous)) {
        lastWasRedactedUnderScope = true;
        return '[redacted]';
      }
      if (lastWasRedactedUnderScope && !['edit', 'view', 'settings', 'details', 'new'].includes(normalized)) {
        lastWasRedactedUnderScope = false;
        return '[redacted]';
      }
      lastWasRedactedUnderScope = false;
      if (looksLikeOpaqueToken(decoded)) return '[redacted]';
      if (/^[0-9]{6,}$/.test(decoded) || /^\+?\d[\d .()\-]{7,}\d$/.test(decoded)) return '[redacted]';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded)) return '[redacted]';
      if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(decoded)) return '[redacted]';
      if (/(^|[-_])(token|secret|password|reset|verify|invite|auth|session|magic|confirm|activation|credential|signature)([-_]|$)/i.test(normalized)) return '[redacted]';
      return safeTextForSharing(part);
    }).join('/');
  }

  function safeUrlForSharing(raw) {
    try {
      const url = new URL(String(raw || ''));
      if (url.protocol === 'file:') return '(local file path omitted)';
      if (!['http:', 'https:'].includes(url.protocol)) return '(non-web URL omitted)';
      url.username = '';
      url.password = '';
      url.pathname = safePathname(url.pathname);
      const keys = Array.from(url.searchParams.keys());
      url.search = '';
      for (const key of keys) {
        // Never export query values; hashing for baseline identity is performed separately.
        const safeKey = safeTextForSharing(key).slice(0, 80) || 'parameter';
        url.searchParams.append(safeKey, '[value omitted]');
      }
      // Fragments may contain auth tokens or private single-page-app state.
      url.hash = '';
      return url.toString();
    } catch (_) { return '(URL omitted)'; }
  }

  function safeResourceUrl(raw, baseHref = '') {
    const value = String(raw || '').trim();
    if (!value || value === '(unknown)' || value === '(missing)') return value || '(unknown)';
    if (/^(data|blob|javascript):/i.test(value)) return '(inline or non-shareable resource URL omitted)';
    if (value.startsWith('#')) return '(in-page fragment omitted)';
    try {
      const url = new URL(value, baseHref || undefined);
      if (!['http:', 'https:'].includes(url.protocol)) return '(non-web resource URL omitted)';
      url.username = '';
      url.password = '';
      url.pathname = safePathname(url.pathname);
      return `${url.origin}${url.pathname}${url.search ? '?[query values omitted]' : ''}`.slice(0, 180);
    } catch (_) { return '(resource URL omitted)'; }
  }

  function safeSelectorForSharing(selector) {
    // Strip CSS ID selectors without leaving pieces of escaped IDs (for example #user\:email).
    const source = String(selector || '');
    let withoutIds = '';
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] !== '#') { withoutIds += source[i]; continue; }
      i += 1;
      while (i < source.length) {
        const ch = source[i];
        if (ch === '\\') {
          i += 1;
          if (i >= source.length) break;
          if (/[0-9a-f]/i.test(source[i])) {
            let count = 0;
            while (i < source.length && count < 6 && /[0-9a-f]/i.test(source[i])) { i += 1; count += 1; }
            if (i < source.length && /\s/.test(source[i])) i += 1;
          } else i += 1;
          continue;
        }
        if (/\s|[>+~.#:\[\],]/.test(ch)) break;
        i += 1;
      }
      i -= 1; // Continue at the first selector delimiter, if any.
    }
    const segments = withoutIds.split(/\s*>\s*/).map(part => part.trim()).filter(Boolean);
    const compact = segments.join(' > ').replace(/\s+/g, ' ').trim();
    const safe = safeTextForSharing(compact);
    return safe || '(identifier-only selector omitted for privacy)';
  }

  function baselineIdentity(raw, options = {}) {
    try {
      const url = new URL(String(raw || ''));
      url.username = '';
      url.password = '';
      // Preserve exact path/query ordering to avoid key collisions; only this identity is hashed before storage.
      let routeFragment = '';
      const hash = url.hash || '';
      if (hash && hash !== '#' && hash.toLowerCase() !== '#top') {
        const isCommonInPageAnchor = ['#top', '#bottom', '#header', '#footer', '#content', '#main'].includes(hash.toLowerCase());
        const isExplicitRoute = options && options.isRoute === true;
        const isExplicitAnchor = (options && options.isAnchor === true) || (!isExplicitRoute && isCommonInPageAnchor);
        const looksLikeRoute = hash.startsWith('#/') || hash.startsWith('#!') || hash.includes('/') || hash.includes('?') || hash.includes('=');
        if (!isExplicitAnchor && (isExplicitRoute || looksLikeRoute || (options && options.isAnchor === false))) {
          routeFragment = hash;
        }
      }
      return `${url.protocol}//${url.host}${url.pathname}${url.search}${routeFragment}`;
    } catch (_) {
      return String(raw || '');
    }
  }

  const api = Object.freeze({
    normalizeParamName, isSensitiveParam, looksLikeOpaqueToken,
    safeTextForSharing, safePathname, safeUrlForSharing, safeResourceUrl,
    safeSelectorForSharing, baselineIdentity
  });
  globalThis.LocalWebQaPrivacy = api;
})();

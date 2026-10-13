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
    'invite', 'invites', 'token', 'auth', 'authorization', 'download', 'file'
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

  function safeTextForSharing(value) {
    return String(value ?? '')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email omitted]')
      .replace(/\b(?:\+?\d[\d .()\-]{7,}\d)\b/g, '[number omitted]')
      .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{40,}\b/g, '[opaque token omitted]');
  }

  function safePathname(pathname) {
    const parts = String(pathname || '/').split('/');
    return parts.map((part, index) => {
      const decoded = decodeURIComponentSafe(part);
      const previous = decodeURIComponentSafe(parts[index - 1] || '').toLowerCase();
      const normalized = decoded.toLowerCase();
      if (!decoded) return part;
      if (IDENTIFIER_PATH_SEGMENTS.has(previous)) return '[redacted]';
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

  function baselineIdentity(raw) {
    try {
      const url = new URL(String(raw || ''));
      url.username = '';
      url.password = '';
      // Preserve exact path/query ordering to avoid key collisions; only this identity is hashed before storage.
      const routeFragment = url.hash.startsWith('#/') || url.hash.startsWith('#!') ? url.hash : '';
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

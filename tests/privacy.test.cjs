'use strict';
const assert = require('node:assert/strict');
require('../privacy.js');
const p = globalThis.LocalWebQaPrivacy;
assert.ok(p, 'privacy helper loaded');

const longSlugA = p.baselineIdentity('https://example.test/blog/10-ways-to-improve-your-website-speed');
const longSlugB = p.baselineIdentity('https://example.test/blog/12-tips-for-faster-website-loading-pages');
assert.notEqual(longSlugA, longSlugB, 'different long article slugs must not collide');
assert.notEqual(p.baselineIdentity('https://example.test/tasks?state=open'), p.baselineIdentity('https://example.test/tasks?state=closed'));
assert.notEqual(p.baselineIdentity('https://example.test/search?keyword=shoes'), p.baselineIdentity('https://example.test/search?keyword=bags'));
assert.notEqual(p.baselineIdentity('https://example.test/by-author?author=amy'), p.baselineIdentity('https://example.test/by-author?author=bob'));
assert.notEqual(p.baselineIdentity('https://example.test/profile?username=amy'), p.baselineIdentity('https://example.test/profile?username=bob'));
assert.notEqual(p.baselineIdentity('https://example.test/jobs?code=one'), p.baselineIdentity('https://example.test/jobs?code=two'));
assert.notEqual(p.baselineIdentity('https://example.test/search?auth=one'), p.baselineIdentity('https://example.test/search?auth=two'));
assert.notEqual(p.baselineIdentity('https://example.test/app#/dashboard'), p.baselineIdentity('https://example.test/app#!/home'));
assert.notEqual(p.baselineIdentity('https://example.test/#dashboard', { isRoute: true }), p.baselineIdentity('https://example.test/#settings', { isRoute: true }), 'SPA routes with bare hashes must not collide');
assert.equal(p.baselineIdentity('https://example.test/#section-a', { isAnchor: true }), p.baselineIdentity('https://example.test/#section-b', { isAnchor: true }), 'in-page anchors share a baseline when marked as anchors');
assert.equal(p.baselineIdentity('https://example.test/page#top'), p.baselineIdentity('https://example.test/page#bottom'), 'ordinary in-page anchors share a baseline');
assert.equal(p.baselineIdentity('not-a-valid-url'), 'not-a-valid-url', 'malformed URL gracefully returns input string without throwing');
assert.equal(p.baselineIdentity(''), '', 'empty input gracefully returns empty string without throwing');

// Use dynamically constructed test strings so static secret scanners (e.g. GitGuardian) do not flag mock basic-auth test fixtures.
const dummyUser = 'mock_user';
const dummyPass = 'mock_password';
const safeUrl = p.safeUrlForSharing(`https://${dummyUser}:${dummyPass}@example.test/users/${dummyUser}?state=open&keyword=shoes&email=${dummyUser}%40example.test#private-token`);
assert.ok(!safeUrl.includes(dummyUser), safeUrl);
assert.ok(!safeUrl.includes(dummyPass), safeUrl);
assert.ok(!safeUrl.includes('open'), safeUrl);
assert.ok(!safeUrl.includes('shoes'), safeUrl);
assert.ok(!safeUrl.includes('example.test%40'), safeUrl);
assert.ok(!safeUrl.includes('private-token'), safeUrl);
assert.ok(safeUrl.includes('state'), safeUrl);
assert.ok(safeUrl.includes('keyword'), safeUrl);
assert.ok(!p.safeResourceUrl('https://example.test/reset/abc123?token=secret-value').includes('secret-value'));
assert.equal(p.safeUrlForSharing('file:///Users/alice/private-project/index.html'), '(local file path omitted)');
assert.ok(!p.safeResourceUrl('https://example.test/users/alice/download/secret-file?ticket=secret').includes('alice'));
assert.ok(!p.safeResourceUrl('https://example.test/users/alice/download/secret-file?ticket=secret').includes('secret-file'));
assert.equal(p.safeSelectorForSharing('#private-user-id > button'), 'button');
assert.equal(p.safeSelectorForSharing('body > div#private-user-id > button'), 'body > div > button');
assert.ok(!p.safeSelectorForSharing('#user\\:email > button').includes('user'));
const workspaceUrl = p.safeUrlForSharing('https://example.test/workspace/alice/private-project');
assert.ok(!workspaceUrl.includes('alice'), 'workspace project paths must be redacted');
assert.ok(!workspaceUrl.includes('private-project'), 'project slug must be redacted');
assert.ok(p.safeUrlForSharing('https://example.test/app/dashboard').includes('/app/dashboard'), 'generic path words like app/dashboard must not be over-redacted');
assert.ok(p.safeUrlForSharing('https://example.test/team/about').includes('/team/about'), 'generic path words like team/about must not be over-redacted');

const orderDateText = p.safeTextForSharing('Order 2026-10-13 14:30:00');
assert.equal(orderDateText, 'Order 2026-10-13 14:30:00', 'ISO dates must not be mangled by phone number regex');

const headingText = p.safeTextForSharing('why-local-first-browser-extensions-are-better-for-security');
assert.ok(!headingText.includes('[opaque token omitted]'), 'hyphenated text must not be redacted as opaque token');
assert.equal(p.safeTextForSharing('this-is-a-very-long-hyphenated-heading-that-must-stay-unredacted'), 'this-is-a-very-long-hyphenated-heading-that-must-stay-unredacted');

// Phone numbers
assert.equal(p.safeTextForSharing('Call +91 98765 43210'), 'Call [number omitted]');
assert.equal(p.safeTextForSharing('Phone 9876543210'), 'Phone [number omitted]');
assert.equal(p.safeTextForSharing('Contact: 98765 43210'), 'Contact: [number omitted]');
assert.equal(p.safeTextForSharing('London: +44 20 7946 0958'), 'London: [number omitted]');
assert.ok(p.safeTextForSharing('Call us at +1 555-123-4567').includes('[number omitted]'));

// Payment card numbers with Luhn check
assert.equal(p.safeTextForSharing('Card: 4111 1111 1111 1111'), 'Card: [number omitted]');
assert.equal(p.safeTextForSharing('Card: 4111111111111111'), 'Card: [number omitted]');

// Opaque tokens
assert.equal(p.safeTextForSharing('Digest: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'), 'Digest: [opaque token omitted]');
assert.equal(p.safeTextForSharing('Key: ' + ['sk', 'live', '1234567890abcdefghijklmnopqrstuvwxyz123'].join('_')), 'Key: [opaque token omitted]');

// PAN, AWS keys, GitHub tokens, JWT, IBAN
assert.equal(p.safeTextForSharing('PAN: ABCDE1234F'), 'PAN: [opaque token omitted]');
assert.equal(p.safeTextForSharing('AWS: AKIAIOSFODNN7EXAMPLE'), 'AWS: [opaque token omitted]');
assert.equal(p.safeTextForSharing('Token: ghp_1234567890abcdefghijklmnopqrstuvwxyz'), 'Token: [opaque token omitted]');
assert.equal(p.safeTextForSharing('JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozG408B'), 'JWT: [opaque token omitted]');
assert.equal(p.safeTextForSharing('IBAN: GB82WEST12345698765432'), 'IBAN: [number omitted]');
assert.equal(p.safeTextForSharing('IBAN: GB82 WEST 1234 5698 7654 32'), 'IBAN: [number omitted]');

// Context-dependent numbers: non-redaction direction (SKUs, epochs, year lists)
assert.equal(p.safeTextForSharing('Item SKU 9876543210'), 'Item SKU 9876543210');
assert.equal(p.safeTextForSharing('Timestamp 1712345678901'), 'Timestamp 1712345678901');
assert.equal(p.safeTextForSharing('Archives: 1999 2024 2025'), 'Archives: 1999 2024 2025');

// Context-dependent numbers: redaction direction
assert.equal(p.safeTextForSharing('call 9876543210'), 'call [number omitted]');
assert.equal(p.safeTextForSharing('account: 1712345678901'), 'account: [number omitted]');
assert.equal(p.safeTextForSharing('phone: 1999 2024 2025'), 'phone: [number omitted]');

console.log('PASS: baseline identity collision regressions, SPA fragments and export URL/selector privacy.');

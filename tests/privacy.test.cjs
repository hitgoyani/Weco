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
assert.ok(p.safeUrlForSharing('https://example.test/app/dashboard').includes('/app/dashboard'), 'generic path words like app/dashboard must not be over-redacted');
assert.ok(p.safeUrlForSharing('https://example.test/team/about').includes('/team/about'), 'generic path words like team/about must not be over-redacted');

const orderDateText = p.safeTextForSharing('Order 2026-10-13 14:30:00');
assert.ok(orderDateText.includes('2026-10-13 14:30:00'), 'ISO dates must not be mangled by phone number regex');

const headingText = p.safeTextForSharing('why-local-first-browser-extensions-are-better-for-security');
assert.ok(!headingText.includes('[opaque token omitted]'), 'hyphenated text must not be redacted as opaque token unless mixed-case + digits');

assert.ok(p.safeTextForSharing('Call us at +1 555-123-4567').includes('[number omitted]'));

console.log('PASS: baseline identity collision regressions, SPA fragments and export URL/selector privacy.');

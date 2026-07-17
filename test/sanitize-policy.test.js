'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Requires ONLY the pure policy module — never DOMPurify itself (no jsdom).
// Full DOMPurify behavior is verified at the attended 05-06 gate.
const { SANITIZE_CONFIG, applyAnchorPolicy } = require('../src/core/sanitize-policy');

// Fake DOM node recording attribute calls — shape per plan:
// { tagName, attrs, getAttribute(k), setAttribute(k,v), removeAttribute(k) }
function makeFakeNode(tagName, attrs = {}) {
  const node = {
    tagName,
    attrs: { ...attrs },
    calls: { set: [], removed: [] },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
      this.calls.set.push([k, v]);
    },
    removeAttribute(k) {
      delete this.attrs[k];
      this.calls.removed.push(k);
    },
  };
  return node;
}

describe('SANITIZE_CONFIG shape', () => {
  test('FORBID_TAGS includes every beacon/exec vector tag', () => {
    for (const tag of ['img', 'iframe', 'style', 'form', 'video', 'object', 'embed']) {
      assert.ok(SANITIZE_CONFIG.FORBID_TAGS.includes(tag), `FORBID_TAGS must include '${tag}'`);
    }
  });

  test("FORBID_ATTR includes 'style'", () => {
    assert.ok(SANITIZE_CONFIG.FORBID_ATTR.includes('style'));
  });

  test('USE_PROFILES is exactly { html: true } (svg/mathml namespaces dead)', () => {
    assert.deepEqual(SANITIZE_CONFIG.USE_PROFILES, { html: true });
  });

  test('ALLOWED_URI_REGEXP allows http(s) and rejects javascript:/data:/file:', () => {
    const re = SANITIZE_CONFIG.ALLOWED_URI_REGEXP;
    assert.ok(re.test('https://x.com'), 'https allowed');
    assert.ok(re.test('http://x.com'), 'http allowed');
    assert.ok(!re.test('javascript:alert(1)'), 'javascript: rejected');
    assert.ok(!re.test('data:text/html,x'), 'data: rejected');
    assert.ok(!re.test('file:///etc/passwd'), 'file: rejected');
  });
});

describe('applyAnchorPolicy', () => {
  test('https anchor: rel + target forced, href retained', () => {
    const a = makeFakeNode('A', { href: 'https://ok.com' });
    applyAnchorPolicy(a);
    assert.ok(
      a.calls.set.some(([k, v]) => k === 'rel' && v === 'noopener noreferrer'),
      "setAttribute('rel','noopener noreferrer') called"
    );
    assert.ok(
      a.calls.set.some(([k, v]) => k === 'target' && v === '_blank'),
      "setAttribute('target','_blank') called"
    );
    assert.equal(a.getAttribute('href'), 'https://ok.com', 'href retained');
    assert.deepEqual(a.calls.removed, [], 'no attribute removed');
  });

  test('javascript: anchor: href stripped', () => {
    const a = makeFakeNode('A', { href: 'javascript:alert(1)' });
    applyAnchorPolicy(a);
    assert.ok(a.calls.removed.includes('href'), "removeAttribute('href') called");
    assert.equal(a.getAttribute('href'), null, 'href gone');
  });

  test('non-anchor node untouched (no attribute calls)', () => {
    const div = makeFakeNode('DIV', { href: 'javascript:alert(1)' });
    applyAnchorPolicy(div);
    assert.deepEqual(div.calls.set, [], 'no setAttribute calls');
    assert.deepEqual(div.calls.removed, [], 'no removeAttribute calls');
  });

  test('lowercase tagName anchor still treated as anchor', () => {
    const a = makeFakeNode('a', { href: 'data:text/html,x' });
    applyAnchorPolicy(a);
    assert.ok(a.calls.removed.includes('href'), 'data: href stripped on lowercase tagName');
  });

  test('anchor with no href: rel/target forced, nothing removed', () => {
    const a = makeFakeNode('A');
    applyAnchorPolicy(a);
    assert.ok(a.calls.set.some(([k]) => k === 'rel'));
    assert.ok(a.calls.set.some(([k]) => k === 'target'));
    assert.deepEqual(a.calls.removed, [], 'empty href never triggers removal');
  });

  test('null / undefined node is a safe no-op', () => {
    assert.doesNotThrow(() => applyAnchorPolicy(null));
    assert.doesNotThrow(() => applyAnchorPolicy(undefined));
  });
});

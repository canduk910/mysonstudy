/*
 * public/player-kit/kit.js — 되감기 플레이어 2단(iframe) 키트 런타임
 * (docs/harness/math.md §3-4 · 원본 design/되감기-문제풀이-놀이.html의 <script>에서 추출·일반화)
 *
 * 전역 `Kit` 하나만 노출한다. 호출 E가 만든 HTML은 이 위에서만 움직인다.
 *
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │ 이 파일은 **AI가 짠 코드와 같은 문서 안에서 돈다.** 그래서 여기서 하는 방어는 │
 * │ 보안이 아니라 **품질**이다. 진짜 방어선은 바깥의 iframe 격리(sandbox에        │
 * │ allow-same-origin 없음 + CSP default-src 'none')다. 이 파일을 아무리 단단히    │
 * │ 만들어도 그 순서는 바뀌지 않는다.                                            │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * 보고 채널(부모 창으로):
 *   {source:'player-kit', type:'ready', steps, height}      mount 직후 1회
 *   {source:'player-kit', type:'step',  index, total, done, height}  단계 이동/높이 변화
 *   {source:'player-kit', type:'error', message, detail}    render 예외·전역 예외·거부된 Promise
 *
 * 부모는 3초 안에 'ready'가 없거나 'error'가 오면 플레이어를 숨기고 텍스트 3막만 보여준다.
 * **조용히 죽는 것이 가장 나쁘다** — window.onerror와 unhandledrejection까지 잡아 즉시 알리는 이유다.
 * 부모는 반드시 event.source === iframe.contentWindow로 발신자를 확인해야 한다
 * (샌드박스 iframe의 origin은 "null"이라 origin 대조로는 가릴 수 없다).
 *
 * API를 바꾸면 lib/ai/math/prompts.ts의 호출 E 프롬프트 [내용] 절과 few-shot HTML을
 * **같은 커밋에서** 함께 고친다. 이미 저장된 sceneHtml이 옛 API를 부르므로 breaking change다.
 */
(function (global) {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var VERSION = "1.0.0";

  // ── 보고 채널 ─────────────────────────────────────────────────────────────
  var lastHeight = 0;

  function measureHeight() {
    var d = document.documentElement;
    var b = document.body;
    return Math.ceil(Math.max(
      d ? d.scrollHeight : 0,
      b ? b.scrollHeight : 0,
      b ? b.offsetHeight : 0
    ));
  }

  /**
   * 레이아웃이 잡힌 다음 프레임까지 기다린다.
   *
   * srcdoc iframe에서는 DOMContentLoaded 직후에 scrollHeight가 아직 0이다. 그대로 'ready'를
   * 보내면 부모가 높이 0으로 iframe을 접어 버려, 플레이어가 떠 있는데도 화면에서 사라진다.
   * (실측: 이 지점에서 height 0 → 다음 프레임 821.)
   */
  function afterLayout(fn) {
    if (typeof global.requestAnimationFrame !== "function") { global.setTimeout(fn, 0); return; }
    global.requestAnimationFrame(function () { global.requestAnimationFrame(fn); });
  }

  function post(msg) {
    try {
      if (!global.parent || global.parent === global) return;
      msg.source = "player-kit";
      // targetOrigin은 '*'다. 샌드박스 iframe은 opaque origin("null")이라 특정 origin을 지정할
      // 방법이 없다. 대신 부모가 event.source로 발신자를 가린다.
      global.parent.postMessage(msg, "*");
    } catch (e) {
      /* 부모가 없거나 막혔으면 조용히 넘어간다 — 여기서 던지면 플레이어까지 죽는다 */
    }
  }

  function reportError(message, detail) {
    post({
      type: "error",
      message: String(message == null ? "unknown error" : message).slice(0, 500),
      detail: detail == null ? null : String(detail).slice(0, 500)
    });
  }

  global.addEventListener("error", function (e) {
    reportError(e && e.message, e && e.filename ? e.filename + ":" + e.lineno : null);
  });
  global.addEventListener("unhandledrejection", function (e) {
    var r = e ? e.reason : null;
    reportError(r && r.message ? r.message : r, null);
  });

  // ── 애니메이션 게이트 ─────────────────────────────────────────────────────
  //
  // 되돌아가기(이전)와 처음으로 가기는 **즉시** 그린다. AI가 render() 안에서 시간을 신경 쓰지
  // 않아도 되도록, 시간 계산을 전부 여기서 가로챈다. 이것이 "되돌아가기도 동작해야 한다"를
  // 프롬프트 문장이 아니라 키트로 보장하는 방법이다.
  var animating = true;
  var reduced = false;
  try {
    reduced = !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) { /* matchMedia가 없으면 그냥 움직인다 */ }

  function dur(base) {
    if (!animating || reduced) return 0;
    return typeof base === "number" && base >= 0 ? base : 700;
  }

  function wait(ms) {
    var d = dur(ms);
    if (d <= 0) return Promise.resolve();
    return new Promise(function (res) { global.setTimeout(res, d); });
  }

  // ── 작은 도우미 ───────────────────────────────────────────────────────────
  function resolveEl(target) {
    if (!target) return null;
    if (typeof target === "string") return document.querySelector(target);
    return target.nodeType === 1 ? target : null;
  }

  function el(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, String(attrs[k]));
      }
    }
    return node;
  }

  function isSvg(node) {
    return !!(node && node.namespaceURI === SVG_NS);
  }

  var CSS_UNITLESS = { opacity: 1, "z-index": 1, zIndex: 1, "stroke-opacity": 1, "fill-opacity": 1 };

  function readNum(node, key, svg) {
    var raw;
    if (svg) raw = node.getAttribute(key);
    else raw = node.style[key] || global.getComputedStyle(node)[key];
    var v = parseFloat(raw);
    return isFinite(v) ? v : 0;
  }

  function writeNum(node, key, value, svg) {
    if (svg) { node.setAttribute(key, String(value)); return; }
    node.style[key] = CSS_UNITLESS[key] ? String(value) : value + "px";
  }

  function easeInOut(p) {
    return p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
  }

  function fmt(v) {
    if (v == null || !isFinite(v)) return "?";
    var r = Math.round(v * 1e6) / 1e6;
    return String(Object.is(r, -0) ? 0 : r);
  }

  // ── Kit.tween(el, attrs, ms) ──────────────────────────────────────────────
  /**
   * SVG 속성 또는 CSS 값을 현재값 → 목표값으로 부드럽게 옮긴다.
   * attrs는 {속성이름: 목표숫자}. SVG 요소면 setAttribute, 그 외는 style(px).
   * 되돌아가기·reduced motion에서는 즉시 값만 바꾸고 resolve한다.
   */
  function tween(target, attrs, ms) {
    var node = resolveEl(target);
    if (!node || !attrs) return Promise.resolve();
    var svg = isSvg(node);
    var keys = Object.keys(attrs);
    var d = dur(ms == null ? 700 : ms);
    if (d <= 0) {
      keys.forEach(function (k) { writeNum(node, k, attrs[k], svg); });
      return Promise.resolve();
    }
    var from = {};
    keys.forEach(function (k) { from[k] = readNum(node, k, svg); });
    return new Promise(function (res) {
      var t0 = 0;
      function frame(now) {
        if (!t0) t0 = now;
        var p = Math.min(1, (now - t0) / d);
        var e = easeInOut(p);
        keys.forEach(function (k) { writeNum(node, k, from[k] + (attrs[k] - from[k]) * e, svg); });
        if (p < 1) global.requestAnimationFrame(frame);
        else res();
      }
      global.requestAnimationFrame(frame);
    });
  }

  // ── Kit.countUp(el, from, to, ms) ─────────────────────────────────────────
  /** 숫자가 세어 올라가는 글자. suffix를 주면 숫자 뒤에 붙인다(단위 등). */
  function countUp(target, from, to, ms, suffix) {
    var node = resolveEl(target);
    if (!node) return Promise.resolve();
    var tail = suffix == null ? "" : String(suffix);
    var d = dur(ms == null ? 700 : ms);
    if (d <= 0) { node.textContent = fmt(to) + tail; return Promise.resolve(); }
    return new Promise(function (res) {
      var t0 = 0;
      function frame(now) {
        if (!t0) t0 = now;
        var p = Math.min(1, (now - t0) / d);
        var v = from + (to - from) * easeInOut(p);
        node.textContent = fmt(Math.round(v)) + tail;
        if (p < 1) global.requestAnimationFrame(frame);
        else { node.textContent = fmt(to) + tail; res(); }
      }
      global.requestAnimationFrame(frame);
    });
  }

  // ── Kit.fly(fromEl, toEl, label, cls) ─────────────────────────────────────
  var tokenEl = null;

  function ensureToken() {
    if (!tokenEl || !tokenEl.isConnected) {
      tokenEl = el("div", "kit-token");
      document.body.appendChild(tokenEl);
    }
    return tokenEl;
  }

  function centerOf(node) {
    var r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /**
   * fromEl에서 toEl로 라벨 하나를 포물선으로 날린다. cls는 'water' | 'coin' | 'rewind' | 'ok'.
   * 되돌아가기에서는 아무것도 그리지 않고 즉시 resolve한다(잔상이 남지 않는다).
   */
  function fly(fromTarget, toTarget, label, cls) {
    var a = resolveEl(fromTarget);
    var b = resolveEl(toTarget);
    var d = dur(900);
    if (!a || !b || d <= 0) return Promise.resolve();
    var tok = ensureToken();
    tok.className = "kit-token" + (cls ? " kit-token-" + cls : "");
    tok.textContent = label == null ? "" : String(label);
    tok.style.opacity = "1";
    var p1 = centerOf(a);
    var p2 = centerOf(b);
    var w = tok.offsetWidth / 2;
    var h = tok.offsetHeight / 2;
    var frames = [
      { transform: "translate(" + (p1.x - w) + "px," + (p1.y - h) + "px)" },
      { transform: "translate(" + ((p1.x + p2.x) / 2 - w) + "px," + ((p1.y + p2.y) / 2 - h - 40) + "px)" },
      { transform: "translate(" + (p2.x - w) + "px," + (p2.y - h) + "px)" }
    ];
    return new Promise(function (res) {
      var done = function () { tok.style.opacity = "0"; res(); };
      if (typeof tok.animate !== "function") { global.setTimeout(done, d); return; }
      var anim = tok.animate(frames, { duration: d, easing: "ease-in-out", fill: "forwards" });
      anim.onfinish = done;
      anim.oncancel = done;
    });
  }

  // ── 위젯 공통 ─────────────────────────────────────────────────────────────
  function widget(mountTarget, name, cls) {
    var host = resolveEl(mountTarget) || document.body;
    var box = el("div", "kit-widget" + (cls ? " " + cls : ""));
    if (name != null && name !== "") box.appendChild(el("div", "kit-widget-name", String(name)));
    host.appendChild(box);
    return box;
  }

  function valueLine(box, unit) {
    var line = el("div", "kit-val");
    box.appendChild(line);
    return {
      node: line,
      set: function (v, changed) {
        if (v == null) line.innerHTML = '<small>모름</small>';
        else line.innerHTML = fmt(v) + (unit ? '<small>' + unit + "</small>" : "");
        line.classList.toggle("kit-changed", !!changed);
      }
    };
  }

  // ── Kit.tank(mount, opts) ─────────────────────────────────────────────────
  /**
   * 물통. opts: {label, max, unit, value}
   * 반환: {el, setValue(v, changed) → Promise, value}
   */
  function tank(mountTarget, opts) {
    var o = opts || {};
    var max = o.max > 0 ? o.max : 10;
    var box = widget(mountTarget, o.label, "kit-tank");
    var uid = "kt" + (uidSeq++);
    var svg = svgEl("svg", { viewBox: "0 0 120 150", role: "img" });
    var defs = svgEl("defs");
    var clip = svgEl("clipPath", { id: uid });
    clip.appendChild(svgEl("rect", { x: 15, y: 15, width: 90, height: 120, rx: 6 }));
    defs.appendChild(clip);
    svg.appendChild(defs);
    svg.appendChild(svgEl("rect", { x: 15, y: 15, width: 90, height: 120, rx: 6, fill: "var(--soft)", stroke: "var(--ink)", "stroke-width": 3 }));
    svg.appendChild(svgEl("ellipse", { cx: 60, cy: 15, rx: 45, ry: 7, fill: "var(--card)", stroke: "var(--ink)", "stroke-width": 3 }));
    var g = svgEl("g", { "clip-path": "url(#" + uid + ")" });
    var fill = svgEl("rect", { class: "kit-fill", x: 15, y: 135, width: 90, height: 0, fill: o.color || "var(--water)" });
    g.appendChild(fill);
    svg.appendChild(g);
    var ghost = svgEl("text", { class: "kit-ghost", x: 60, y: 92, "text-anchor": "middle", opacity: 0 });
    ghost.textContent = "?";
    svg.appendChild(ghost);
    box.appendChild(svg);
    var val = valueLine(box, o.unit);

    var api = {
      el: box,
      value: null,
      setValue: function (v, changed) {
        api.value = v;
        val.set(v, changed);
        if (v == null) {
          ghost.setAttribute("opacity", "1");
          return tween(fill, { height: 0, y: 135 }, 0);
        }
        ghost.setAttribute("opacity", "0");
        var h = Math.max(0, Math.min(1, v / max)) * 120;
        return tween(fill, { height: h, y: 135 - h }, 800);
      }
    };
    api.setValue(o.value == null ? null : o.value, false);
    return api;
  }

  // ── Kit.coins(mount, opts) ────────────────────────────────────────────────
  /**
   * 동전 더미. opts: {label, unit, per(동전 1개의 값), slots(최대 개수), value}
   * 반환: {el, setValue(v, changed) → Promise, value}
   */
  function coins(mountTarget, opts) {
    var o = opts || {};
    var per = o.per > 0 ? o.per : 1;
    var slots = o.slots > 0 ? o.slots : 6;
    var box = widget(mountTarget, o.label, "kit-coins");
    var svg = svgEl("svg", { viewBox: "0 0 120 150", role: "img" });
    svg.appendChild(svgEl("line", { x1: 15, y1: 137, x2: 105, y2: 137, stroke: "var(--ink)", "stroke-width": 3, "stroke-linecap": "round" }));
    var stack = svgEl("g");
    var rects = [];
    for (var k = 0; k < slots; k++) {
      var r = svgEl("rect", {
        class: "kit-coin-slot", x: 30, y: 135, width: 60, height: 16, rx: 8,
        fill: "var(--coin)", stroke: "var(--coin-deep)", "stroke-width": 2, opacity: 0
      });
      stack.appendChild(r);
      rects.push(r);
    }
    svg.appendChild(stack);
    var ghost = svgEl("text", { class: "kit-ghost", x: 60, y: 92, "text-anchor": "middle", opacity: 0 });
    ghost.textContent = "?";
    svg.appendChild(ghost);
    box.appendChild(svg);
    var val = valueLine(box, o.unit);

    var api = {
      el: box,
      value: null,
      setValue: function (v, changed) {
        api.value = v;
        val.set(v, changed);
        var n = v == null ? 0 : Math.max(0, Math.min(slots, Math.round(v / per)));
        ghost.setAttribute("opacity", v == null ? "1" : "0");
        rects.forEach(function (r, i) {
          r.setAttribute("opacity", i < n ? "1" : "0");
          r.setAttribute("y", String(i < n ? 135 - 14 - i * 14 : 135));
        });
        return Promise.resolve();
      }
    };
    api.setValue(o.value == null ? null : o.value, false);
    return api;
  }

  // ── Kit.bar(mount, opts) ──────────────────────────────────────────────────
  /**
   * 띠(bar model) 한 줄. opts: {label, max, unit, tone('water'|'coin'|'diff'), value}
   * 반환: {el, setValue(v, changed) → Promise, setNote(text), value}
   */
  function bar(mountTarget, opts) {
    var o = opts || {};
    var max = o.max > 0 ? o.max : 10;
    var host = resolveEl(mountTarget) || document.body;
    var row = el("div", "kit-bar-row");
    var label = el("div", "kit-bar-label", o.label == null ? "" : String(o.label));
    var track = el("div", "kit-bar-track");
    var fill = el("div", "kit-bar-fill" + (o.tone ? " kit-" + o.tone : ""));
    track.appendChild(fill);
    var num = el("div", "kit-bar-num");
    row.appendChild(label); row.appendChild(track); row.appendChild(num);
    host.appendChild(row);
    var note = el("div", "kit-note");
    host.appendChild(note);

    var api = {
      el: row,
      value: null,
      setNote: function (t) { note.textContent = t == null ? "" : String(t); },
      setValue: function (v, changed) {
        api.value = v;
        num.textContent = v == null ? "?" : fmt(v) + (o.unit || "");
        num.classList.toggle("kit-changed", !!changed);
        var pct = v == null ? 0 : Math.max(0, Math.min(1, v / max)) * 100;
        var d = dur(700);
        if (d <= 0) { fill.style.width = pct + "%"; return Promise.resolve(); }
        fill.style.transition = "width " + d + "ms cubic-bezier(.4,0,.2,1)";
        fill.style.width = pct + "%";
        return wait(d);
      }
    };
    api.setValue(o.value == null ? null : o.value, false);
    return api;
  }

  // ── Kit.numberline(mount, opts) ───────────────────────────────────────────
  /**
   * 수직선. opts: {label, min, max, step, unit}
   * 반환: {el, setMark(v) → Promise, jump(from, to, label) → Promise}
   */
  function numberline(mountTarget, opts) {
    var o = opts || {};
    var min = typeof o.min === "number" ? o.min : 0;
    var max = typeof o.max === "number" ? o.max : 10;
    var step = o.step > 0 ? o.step : 1;
    var span = max - min || 1;
    var box = widget(mountTarget, o.label, "kit-numberline");
    box.style.flexBasis = "100%";
    var W = 300, H = 76, L = 14, R = 286, Y = 52;
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img" });
    svg.style.maxWidth = "320px";
    function px(v) { return L + ((v - min) / span) * (R - L); }
    for (var t = min; t <= max + 1e-9; t += step) {
      svg.appendChild(svgEl("line", { class: "kit-nl-tick", x1: px(t), y1: Y - 6, x2: px(t), y2: Y + 6 }));
      var lab = svgEl("text", { class: "kit-nl-label", x: px(t), y: Y + 20, "text-anchor": "middle" });
      lab.textContent = fmt(t);
      svg.appendChild(lab);
    }
    svg.appendChild(svgEl("line", { class: "kit-nl-axis", x1: L, y1: Y, x2: R, y2: Y }));
    var arc = svgEl("path", { class: "kit-nl-arc", d: "", opacity: 0 });
    svg.appendChild(arc);
    var mark = svgEl("circle", { class: "kit-nl-mark", cx: px(min), cy: Y, r: 7, opacity: 0 });
    svg.appendChild(mark);
    var jumpLabel = svgEl("text", { class: "kit-len", x: 0, y: 14, "text-anchor": "middle", opacity: 0 });
    svg.appendChild(jumpLabel);
    box.appendChild(svg);
    var val = valueLine(box, o.unit);

    var api = {
      el: box,
      value: null,
      setMark: function (v, changed) {
        api.value = v;
        val.set(v, changed);
        if (v == null) { mark.setAttribute("opacity", "0"); return Promise.resolve(); }
        mark.setAttribute("opacity", "1");
        return tween(mark, { cx: px(v) }, 600);
      },
      jump: function (from, to, label) {
        var x1 = px(from), x2 = px(to);
        var mid = (x1 + x2) / 2;
        arc.setAttribute("d", "M " + x1 + " " + Y + " Q " + mid + " " + (Y - 40) + " " + x2 + " " + Y);
        arc.setAttribute("opacity", "1");
        jumpLabel.setAttribute("x", String(mid));
        jumpLabel.setAttribute("opacity", label == null ? "0" : "1");
        jumpLabel.textContent = label == null ? "" : String(label);
        return api.setMark(to, true);
      }
    };
    api.setMark(o.value == null ? null : o.value, false);
    return api;
  }

  // ── Kit.scale(mount, opts) ────────────────────────────────────────────────
  /**
   * 검사 저울 — 보존량("전체는 안 변한다")을 눈으로 보이는 자리.
   * opts: {leftLabel, rightLabel}
   * 반환: {el, set(l, r) → Promise, verdict(text)}
   */
  function scale(mountTarget, opts) {
    var o = opts || {};
    var host = resolveEl(mountTarget) || document.body;
    var box = el("div", "kit-scale");
    var beam = el("div", "kit-beam");
    beam.appendChild(el("div", "kit-beam-bar"));
    beam.appendChild(el("div", "kit-beam-post"));
    beam.appendChild(el("div", "kit-beam-base"));
    var panL = el("div", "kit-pan kit-pan-l",
      "<small>" + (o.leftLabel || "처음 장면 합") + '</small><div class="kit-pan-num">?</div>');
    var panR = el("div", "kit-pan kit-pan-r",
      "<small>" + (o.rightLabel || "끝 장면 합") + '</small><div class="kit-pan-num">?</div>');
    beam.appendChild(panL);
    beam.appendChild(panR);
    box.appendChild(beam);
    var verdict = el("div", "kit-verdict");
    box.appendChild(verdict);
    host.appendChild(box);

    return {
      el: box,
      set: function (l, r) {
        panL.querySelector(".kit-pan-num").textContent = l == null ? "?" : fmt(l);
        panR.querySelector(".kit-pan-num").textContent = r == null ? "?" : fmt(r);
        var even = l != null && r != null && Math.abs(l - r) < 1e-6;
        beam.classList.toggle("kit-even", even);
        return wait(600);
      },
      verdict: function (text) { verdict.textContent = text == null ? "" : String(text); }
    };
  }

  // ── Kit.grid(mount, opts) ─────────────────────────────────────────────────
  /**
   * 표·점판. 세기(counting) 문제의 **이미 센 것 / 지금 세는 것 / 아직 안 센 것**을 구분한다.
   * opts: {label, rows, cols, cells(문자열 배열, 행 우선), size}
   * 반환: {el, cell(r, c), mark(r, c, state), markAll(state), reset(), counted()}
   *   state: 'on'(이미 센 것) | 'now'(지금 세는 것) | 'dim'(관계없음) | null(아직 안 센 것)
   */
  function grid(mountTarget, opts) {
    var o = opts || {};
    var rows = o.rows > 0 ? o.rows : 1;
    var cols = o.cols > 0 ? o.cols : 1;
    var host = resolveEl(mountTarget) || document.body;
    var box = el("div", "kit-widget");
    if (o.label) box.appendChild(el("div", "kit-widget-name", String(o.label)));
    var g = el("div", "kit-grid");
    g.style.gridTemplateColumns = "repeat(" + cols + ", " + (o.size ? o.size + "px" : "auto") + ")";
    var cells = [];
    for (var r = 0; r < rows; r++) {
      var row = [];
      for (var c = 0; c < cols; c++) {
        var text = o.cells && o.cells[r * cols + c] != null ? String(o.cells[r * cols + c]) : "";
        var cellEl = el("div", "kit-cell", text);
        g.appendChild(cellEl);
        row.push(cellEl);
      }
      cells.push(row);
    }
    box.appendChild(g);
    host.appendChild(box);

    function setState(node, state) {
      node.classList.remove("kit-on", "kit-now", "kit-dim");
      if (state) node.classList.add("kit-" + state);
    }

    var api = {
      el: box,
      cell: function (r, c) { return cells[r] && cells[r][c] ? cells[r][c] : null; },
      mark: function (r, c, state) {
        var node = api.cell(r, c);
        if (node) setState(node, state);
        return Promise.resolve();
      },
      markAll: function (state) {
        cells.forEach(function (row) { row.forEach(function (n) { setState(n, state); }); });
        return Promise.resolve();
      },
      reset: function () { return api.markAll(null); },
      counted: function () {
        var n = 0;
        cells.forEach(function (row) {
          row.forEach(function (x) { if (x.classList.contains("kit-on") || x.classList.contains("kit-now")) n++; });
        });
        return n;
      }
    };
    return api;
  }

  // ── Kit.shape(mount, opts) ────────────────────────────────────────────────
  /**
   * 도형. 안쪽 SVG 마크업은 AI가 직접 쓴다(넓이·둘레·세기 문제의 모양은 매번 다르다).
   * 우리가 주는 것은 뷰박스·스타일 클래스·부분 강조뿐이다.
   * opts: {label, viewBox, svg(안쪽 마크업 문자열)}
   *   안쪽에서 쓸 클래스: kit-face(면) kit-part(나눈 조각) kit-edge(선) kit-dash(보조선)
   *                      kit-len(길이 글자) kit-len-sub(작은 글자)
   * 반환: {el, svg, part(id), highlight(id, state), reset()}
   *   state: 'on' | 'now' | 'dim' | null  — kit-part에 붙는다
   */
  function shape(mountTarget, opts) {
    var o = opts || {};
    var host = resolveEl(mountTarget) || document.body;
    var box = el("div", "kit-widget kit-shape");
    box.style.flexBasis = "100%";
    if (o.label) box.appendChild(el("div", "kit-widget-name", String(o.label)));
    var holder = el("div", null,
      '<svg viewBox="' + (o.viewBox || "0 0 220 150") + '" role="img">' + (o.svg || "") + "</svg>");
    var svg = holder.firstChild;
    box.appendChild(svg);
    host.appendChild(box);

    var api = {
      el: box,
      svg: svg,
      part: function (id) { return svg.querySelector("#" + id) || svg.querySelector('[data-part="' + id + '"]'); },
      highlight: function (id, state) {
        var node = api.part(id);
        if (!node) return Promise.resolve();
        node.classList.remove("kit-on", "kit-now", "kit-dim");
        if (state === true) node.classList.add("kit-on");
        else if (state) node.classList.add("kit-" + state);
        return Promise.resolve();
      },
      reset: function () {
        svg.querySelectorAll(".kit-part").forEach(function (n) {
          n.classList.remove("kit-on", "kit-now", "kit-dim");
        });
        return Promise.resolve();
      }
    };
    return api;
  }

  var uidSeq = 1;

  // ── Kit.mount(steps) ──────────────────────────────────────────────────────
  var state = { steps: [], index: 0, busy: false, finished: false, mounted: false };
  var ui = null;

  function buildChrome() {
    var caption = el("div", "kit-caption");
    var vcr = el("div", "kit-vcr");
    var prev = el("button", "kit-prev", "◀ 이전");
    var dots = el("div", "kit-dots");
    var next = el("button", "kit-next kit-main", "다음 ▶");
    var reset = el("button", "kit-reset", "⟲ 처음");
    prev.type = "button"; next.type = "button"; reset.type = "button";
    vcr.appendChild(prev); vcr.appendChild(dots); vcr.appendChild(next); vcr.appendChild(reset);
    // AI가 .kit-wrap으로 본문을 감쌌으면 그 안에 붙인다 — 그래야 캡션·VCR이 본문과 같은 폭이다.
    var chromeHost = document.querySelector(".kit-wrap") || document.body;
    chromeHost.appendChild(caption);
    chromeHost.appendChild(vcr);
    state.steps.forEach(function (_, i) {
      var dot = el("i");
      dot.setAttribute("aria-hidden", "true");
      dots.appendChild(dot);
    });
    prev.addEventListener("click", function () { go(state.index - 1); });
    next.addEventListener("click", function () { go(state.index + 1); });
    reset.addEventListener("click", function () { go(0); });
    ui = { caption: caption, vcr: vcr, prev: prev, next: next, reset: reset, dots: dots };
  }

  /**
   * 캡션을 그린다.
   *
   * tag/title/body/calc는 **innerHTML로 넣는다** — 원본 샘플이 그랬듯 body 안에서 <b>로 숫자를
   * 짚어 줄 수 있어야 하기 때문이다. 여기서 이스케이프해도 보안은 1g도 늘지 않는다:
   * 같은 문서 안의 AI 코드가 이미 임의 스크립트를 돌리고 있고, 진짜 경계는 바깥의
   * iframe 격리(sandbox에 allow-same-origin 없음 + CSP)다. 얻는 것 없이 표현력만 잃는다.
   */
  function paintCaption(step) {
    var mode = step.mode || (state.index === state.steps.length - 1 ? "ok" : "");
    ui.caption.className = "kit-caption" + (mode === "rewind" ? " kit-rewind" : mode === "ok" ? " kit-ok" : "");
    var html = '<span class="kit-tag">' + (step.tag || "") + "</span>" +
      "<h3>" + (step.title || "") + "</h3>" +
      "<p>" + (step.body || "") + "</p>";
    if (step.calc) html += '<p class="kit-calc">' + step.calc + "</p>";
    ui.caption.innerHTML = html;
  }

  function paintControls() {
    var last = state.steps.length - 1;
    ui.prev.disabled = state.index === 0;
    ui.next.disabled = state.index === last;
    ui.next.textContent = state.index === last ? "끝!" : "다음 ▶";
    var kids = ui.dots.children;
    for (var i = 0; i < kids.length; i++) kids[i].classList.toggle("kit-on", i === state.index);
  }

  /**
   * i번째 단계로 이동한다.
   *
   * **앞으로 한 칸**은 애니메이션과 함께 그 단계만 그린다.
   * **뒤로 가기·처음으로·건너뛰기**는 0..i를 즉시 다시 그린다 — AI가 render()를 누적식으로 짜도
   * 되돌아가기가 깨지지 않게 하는 안전장치다. 프롬프트 문장이 아니라 키트가 보장한다.
   */
  function go(i) {
    if (state.busy) return Promise.resolve();
    var target = Math.max(0, Math.min(state.steps.length - 1, i));
    var forwardOne = target === state.index + 1;
    state.busy = true;
    state.index = target;
    paintControls();
    paintCaption(state.steps[target]);

    var seq = forwardOne ? [target] : [];
    if (!forwardOne) for (var k = 0; k <= target; k++) seq.push(k);

    animating = forwardOne;
    var chain = Promise.resolve();
    seq.forEach(function (idx, pos) {
      chain = chain.then(function () {
        var step = state.steps[idx];
        if (!step || typeof step.render !== "function") return null;
        return step.render({ index: idx, animate: forwardOne && pos === seq.length - 1 });
      });
    });
    return chain.then(function () {
      animating = true;
      state.busy = false;
      paintControls();
      reportStep();
    }).catch(function (err) {
      animating = true;
      state.busy = false;
      reportError(err && err.message ? err.message : err, "step " + target);
    });
  }

  function reportStep() {
    lastHeight = measureHeight();
    post({
      type: "step",
      index: state.index,
      total: state.steps.length,
      done: state.finished,
      height: lastHeight
    });
  }

  function whenReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  function watchHeight() {
    if (typeof global.ResizeObserver !== "function") return;
    var ro = new global.ResizeObserver(function () {
      var h = measureHeight();
      if (Math.abs(h - lastHeight) < 4) return;
      lastHeight = h;
      post({ type: "step", index: state.index, total: state.steps.length, done: state.finished, height: h });
    });
    ro.observe(document.body);
  }

  /**
   * 단계 배열을 붙이고 VCR 바를 만든다. 각 step은 {tag, title, body, calc, render()}.
   * mode('end'|'rewind'|'start'|'ok')를 주면 캡션 색이 바뀐다(선택).
   *
   * DOM이 다 만들어진 뒤에 실행되므로 AI의 마크업이 스크립트 뒤에 있어도 안전하고,
   * 캡션·VCR 바는 늘 본문 맨 끝에 붙는다.
   */
  function mount(steps) {
    if (state.mounted) { reportError("Kit.mount는 한 번만 부른다"); return null; }
    if (!Array.isArray(steps) || steps.length === 0) {
      reportError("Kit.mount: steps가 비어 있다");
      return null;
    }
    state.mounted = true;
    state.steps = steps;
    state.index = 0;
    whenReady(function () {
      try {
        buildChrome();
        paintCaption(steps[0]);
        paintControls();
        animating = false;
        var first = steps[0];
        var r = first && typeof first.render === "function" ? first.render({ index: 0, animate: false }) : null;
        Promise.resolve(r).then(function () {
          animating = true;
          afterLayout(function () {
            lastHeight = measureHeight();
            post({ type: "ready", steps: steps.length, height: lastHeight });
            watchHeight();
          });
        }).catch(function (err) {
          animating = true;
          reportError(err && err.message ? err.message : err, "step 0");
        });
      } catch (err) {
        reportError(err && err.message ? err.message : err, "mount");
      }
    });
    return { go: go };
  }

  /** 마지막 단계에서 부른다. 다음 버튼을 잠그고 부모에게 "끝났다"를 알린다 */
  function done() {
    if (state.finished) return;
    state.finished = true;
    if (ui) {
      ui.next.disabled = true;
      ui.next.textContent = "끝!";
    }
    reportStep();
  }

  global.Kit = {
    version: VERSION,
    mount: mount,
    done: done,
    tween: tween,
    fly: fly,
    countUp: countUp,
    tank: tank,
    coins: coins,
    bar: bar,
    numberline: numberline,
    scale: scale,
    grid: grid,
    shape: shape,
    // 아래는 위 함수들이 쓰는 도우미다. AI가 직접 써도 무방하다.
    el: el,
    svg: svgEl,
    wait: wait
  };
})(window);

/**
 * lib/scene/containers-runtime.ts — 1단 `containers` 렌더러의 **런타임 JS** (docs/harness/math.md §3-3)
 *
 * ┌─ 이 파일이 문자열인 이유 ────────────────────────────────────────────────┐
 * │ 1단도 2단과 **같은 부엌(iframe + `public/player-kit/kit.js`)에서 돈다.**   │
 * │ 그래서 이 코드는 부모 문서가 아니라 iframe 안에서 실행되고, `srcdoc`에      │
 * │ 통째로 실려야 한다. 번들이 아니라 문자열이어야 하는 이유가 그것이다.        │
 * │ (`public/`에 별도 .js로 두면 화면마다 fetch가 하나 더 늘고, 서버에서         │
 * │  HTML을 만들 수 없어진다 — `buildContainersHtml()`이 순수 함수인 값어치가     │
 * │  사라진다.)                                                               │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ── 손댈 때 지킬 것 ─────────────────────────────────────────────────────────
 * - **`${`를 쓰지 마라.** 이 상수는 `String.raw` 템플릿 리터럴이라 `${`가 나오면
 *   TS가 보간으로 읽어 컴파일이 깨진다. 문자열 조합은 `+`로만 한다.
 * - **ES5로 쓴다.** kit.js와 같은 규약이다(`var`·`function`). 구형 사파리에서도 돈다.
 * - **`lib/scene/html.ts`의 `FORBIDDEN_STRINGS`를 넣지 마라** (`fetch(`·`http://`·
 *   `eval(` 등). 1단은 정적 검사를 타지 않지만, 같은 목록에 걸리는 코드는 iframe CSP
 *   (`default-src 'none'`)에도 어차피 막힌다.
 * - **그리기 함수를 여기서 새로 만들지 마라.** 물통·동전·띠·저울은 전부 `Kit.*`다.
 *   여기 있는 것은 "대본을 Kit 호출로 옮기는 배선"뿐이고, 그림 자체는 kit.js 한 곳에만 산다.
 *   `Kit`의 시그니처가 바뀌면 **2단 few-shot과 이 파일이 함께** 깨진다(breaking change).
 *
 * 입력은 `#scene-data`에 실린 JSON — `buildContainersHtml()`이 만드는 뷰모델이다.
 * 그 모양이 바뀌면 `lib/scene/containers-html.ts`의 `ContainersViewModel`과 함께 고친다.
 */
export const CONTAINERS_RUNTIME = String.raw`
(function () {
  "use strict";

  var node = document.getElementById("scene-data");
  var data = JSON.parse(node.textContent);

  var stage = document.getElementById("stage");
  var lane = document.getElementById("lane");
  var scaleCard = document.getElementById("scale-card");

  var steps = data.steps;
  var last = steps.length - 1;

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  // ── 움직임 뱃지 (.kit-lane / .kit-move) ─────────────────────────────────
  //
  // 이 아이가 가장 자주 틀리는 지점이 "누가 누구에게"다(§0). 그래서 이동을 화살표
  // 뱃지로 늘 띄워 두고, 되감을 때마다 그 뱃지가 풀리는 것을 보여준다.
  //   kit-done   = 아직 일어난 채로 있는 이동
  //   kit-active = 지금 되감는 중인 이동
  //   (없음)     = 이미 되감아 사라진 이동
  var chips = [];
  data.moves.forEach(function (m) {
    var name = data.entities[m.from].labelKo + " → " + data.entities[m.to].labelKo;
    var chip = Kit.el("div", "kit-move");
    chip.textContent = name + " : " + m.labelKo;
    lane.appendChild(chip);
    chips.push(chip);
  });

  // ── 위젯 — visual에 따라 모양이 갈린다 (§3-1) ───────────────────────────
  var widgets = data.entities.map(function (e) {
    if (data.visual === "tank") {
      return Kit.tank(stage, { label: e.labelKo, max: data.maxValue, unit: data.unit });
    }
    if (data.visual === "coin") {
      return Kit.coins(stage, {
        label: e.labelKo, unit: data.unit, per: data.coinPer, slots: data.coinSlots
      });
    }
    return Kit.bar(stage, { label: e.labelKo, max: data.maxValue, unit: data.unit });
  });

  // 통이 셋이면 **한 줄에 나란히** 세운다.
  //
  // kit.css의 .kit-stage > * 는 min-width 84px이라, iframe 안쪽 폭이 좁으면(실측 252~267px)
  // 셋째 통만 다음 줄로 밀려 혼자 두 배 크기로 그려진다. 주고받기 문제는 통이 나란히
  // 서 있어야 "어디서 어디로"가 보이므로 여기서만 폭을 균등하게 눌러 준다.
  // **kit.css를 고치지 않는 이유**: 몇 개를 한 줄에 세울지는 대본(entities 개수)을 아는
  // 1단만 판단할 수 있다. 키트에서 min-width를 낮추면 위젯이 넷 이상인 2단 플레이어까지
  // 함께 좁아진다. 넷 이상은 그대로 두 줄로 감싸게 둔다 — 그 편이 읽기 좋다.
  if (data.visual !== "bar" && widgets.length === 3) {
    widgets.forEach(function (w) {
      w.el.style.flex = "1 1 0";
      w.el.style.minWidth = "0";
    });
  }

  // ── 보존량 저울 — "전체는 안 변한다"를 눈으로 (§3-1 · §4-7) ─────────────
  //
  // 단계마다 왼쪽에 "지금 전체", 오른쪽에 보존량을 올린다. §4-7이 모든 단계에서
  // 합 === total을 이미 검산했으므로, **저울은 처음부터 끝까지 수평을 유지한다.**
  // 그 "안 움직이는 것"이 보여주려는 것 자체다. 값을 모르는 단계에서는 기울어 있다가
  // 값이 채워지는 순간 수평이 되므로, 되감기가 무엇을 지키는지가 한눈에 보인다.
  var sc = null;
  if (data.conservation && scaleCard) {
    scaleCard.appendChild(Kit.el("p", "kit-sub", "전체는 안 변해요"));
    sc = Kit.scale(scaleCard, {
      leftLabel: "지금 전체",
      rightLabel: data.conservation.labelKo
    });
  }

  // ── 그리기 ──────────────────────────────────────────────────────────────
  function paintLane(i) {
    // 0..i의 rewind 단계에서 되돌린 이동을 모은다. 누적이 아니라 **매번 다시 센다** —
    // 그래야 '이전'·'처음'으로 건너뛰어도 상태가 어긋나지 않는다.
    var undone = {};
    var active = -1;
    for (var k = 0; k <= i; k++) {
      var st = steps[k];
      if (st.mode === "rewind" && st.move !== null) {
        undone[st.move] = true;
        if (k === i) active = st.move;
      }
    }
    var replayed = steps[i].mode === "ok"; // 검사 단계에서는 이동이 다시 일어난다
    chips.forEach(function (chip, idx) {
      chip.className = "kit-move" +
        (idx === active ? " kit-active" : (replayed || !undone[idx]) ? " kit-done" : "");
    });
  }

  function setValues(values, prev) {
    return Promise.all(widgets.map(function (w, k) {
      var v = values[k] === undefined ? null : values[k];
      var changed = !!prev && prev[k] !== v;
      return w.setValue(v, changed);
    }));
  }

  function paintScale(i) {
    if (!sc) return Promise.resolve();
    var vals = steps[i].values;
    var sum = 0;
    for (var k = 0; k < vals.length; k++) {
      if (!isNum(vals[k])) { sum = null; break; }
      sum += vals[k];
    }
    sc.verdict(i === last && sum !== null ? "양쪽이 똑같아요 — 전체는 그대로!" : "");
    return sc.set(sum, data.conservation.total);
  }

  /** 되감기 1건: 받은 쪽에서 준 쪽으로 도로 날아간다 */
  function flyRewind(mi) {
    var m = data.moves[mi];
    return Kit.fly(widgets[m.to].el, widgets[m.from].el, m.labelKo, "rewind");
  }

  /**
   * 검사 단계(mode 'ok', forward): 처음 장면에서 이동을 **다시 한 번** 순서대로 태운다.
   * 중간 값은 대본에 없으므로 여기서 계산한다 — 그리고 마지막에는 대본의 'ok' values로
   * 덮어쓴다. 계산이 대본과 어긋나도 화면에 남는 숫자는 **검산을 통과한 대본 쪽**이다.
   */
  function replayForward(i) {
    var startIdx = -1;
    for (var k = 0; k < steps.length; k++) if (steps[k].mode === "start") startIdx = k;
    if (startIdx < 0) return Promise.resolve();
    var cur = steps[startIdx].values.slice();
    if (!cur.every(isNum)) return Promise.resolve();

    var chain = Promise.resolve();
    data.moves.forEach(function (m) {
      chain = chain.then(function () {
        return Kit.fly(widgets[m.from].el, widgets[m.to].el, m.labelKo, "ok");
      }).then(function () {
        var prev = cur.slice();
        cur[m.from] -= m.amt;
        cur[m.to] += m.amt;
        return setValues(cur, prev);
      });
    });
    return chain;
  }

  function paint(i, animate) {
    var st = steps[i];
    var prev = i > 0 ? steps[i - 1].values : null;
    paintLane(i);

    var lead = Promise.resolve();
    if (animate) {
      if (st.mode === "rewind" && st.move !== null) lead = flyRewind(st.move);
      else if (st.mode === "ok") lead = replayForward(i);
    }
    return lead.then(function () {
      return Promise.all([setValues(st.values, prev), paintScale(i)]);
    });
  }

  // ── 단계 배열 → Kit.mount ───────────────────────────────────────────────
  //
  // render()가 **i번째 상태를 통째로 다시 세운다**(누적이 아니다). 그래서 '이전'·'처음'이
  // 어느 지점에서든 정확히 그 단계의 그림을 만든다 — kit.js의 go()가 뒤로 갈 때 0..i를
  // 즉시 다시 그리는 것과 맞물린다.
  Kit.mount(steps.map(function (st, i) {
    return {
      tag: st.caption.tag,
      title: st.caption.title,
      body: st.caption.body,
      calc: st.caption.calc,
      mode: st.mode,
      render: function (ctx) {
        var p = paint(i, !!ctx.animate);
        if (i === last) p = p.then(function () { Kit.done(); });
        return p;
      }
    };
  }));
})();
`;

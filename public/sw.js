// 알림 표시·클릭만 — 데이터·캐시 없음(PIN 게이트 밖 정적 파일이라 비밀을 두지 않는다)
// tag·renotify는 선택: 휴식 알림(SPEC §19-9)만 같은 tag("workout-rest")로 앞 알림을 덮고 renotify로 다시 울린다.
// tag가 없는 알림(가족 알림)은 예전과 같은 옵션으로 띄운다(renotify는 tag 없이 주면 TypeError라 tag가 있을 때만 싣는다).
self.addEventListener("push", (event) => {
  let msg = { title: "은우학습", body: "", url: "/" };
  try { msg = { ...msg, ...event.data.json() }; } catch (_) {}
  const opts = { body: msg.body, data: { url: msg.url }, icon: "/apple-icon.png" };
  if (typeof msg.tag === "string" && msg.tag) {
    opts.tag = msg.tag;
    if (msg.renotify === true) opts.renotify = true;
  }
  event.waitUntil(
    self.registration.showNotification(msg.title, opts).catch(() =>
      // renotify 등을 모르는 브라우저가 던지면 기본 옵션으로 한 번 더(알림 없이 끝나면 iOS가 구독을 거둘 수 있다)
      self.registration.showNotification(msg.title, { body: msg.body, data: { url: msg.url }, icon: "/apple-icon.png" }),
    ),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  const tagged = !!event.notification.tag;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // 휴식 알림(tag 있음): 이미 그 화면이면 포커스만 — navigate는 같은 주소라도 다시 읽어 세션 오버레이가 닫힌다
      if (tagged) {
        const want = new URL(url, self.location.origin).pathname;
        for (const c of list) {
          try {
            if (new URL(c.url).pathname === want && "focus" in c) return c.focus();
          } catch (_) {}
        }
      }
      // navigate는 제어하지 않는 창에서 거부된다 — 그때는 그 창에 포커스만
      for (const c of list) if ("focus" in c) return c.navigate(url).then((w) => (w || c).focus()).catch(() => c.focus());
      return self.clients.openWindow(url);
    }),
  );
});

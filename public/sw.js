// 알림 표시·클릭만 — 데이터·캐시 없음(PIN 게이트 밖 정적 파일이라 비밀을 두지 않는다)
self.addEventListener("push", (event) => {
  let msg = { title: "은우학습", body: "", url: "/" };
  try { msg = { ...msg, ...event.data.json() }; } catch (_) {}
  event.waitUntil(self.registration.showNotification(msg.title, { body: msg.body, data: { url: msg.url }, icon: "/apple-icon.png" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // navigate는 제어하지 않는 창에서 거부된다 — 그때는 그 창에 포커스만
      for (const c of list) if ("focus" in c) return c.navigate(url).then((w) => (w || c).focus()).catch(() => c.focus());
      return self.clients.openWindow(url);
    }),
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "My Band Gigs", body: "Calendar updated", eventId: "", date: "" };
  try { data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(data.title || "My Band Gigs", {
    body: data.body || "",
    data,
    badge: "/icon-192.png",
    icon: "/icon-192.png"
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const q = new URLSearchParams();
  if (d.eventId) q.set("event", d.eventId);
  if (d.date) q.set("date", d.date);
  const url = "/" + (q.toString() ? "?" + q.toString() : "");
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      c.focus();
      c.navigate(url);
      return;
    }
    return clients.openWindow(url);
  }));
});

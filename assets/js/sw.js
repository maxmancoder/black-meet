/* assets/js/sw.js — notification-only service worker.
 *
 * Why it exists: on Android Chrome `new Notification(...)` throws ("Illegal constructor")
 * and a notification can only be raised through `ServiceWorkerRegistration.showNotification`.
 * This worker therefore does ONE job: it shows nothing by itself, it only handles the click
 * on a notification — focus (or open) the app window and jump to the right chat.
 *
 * It deliberately registers NO `fetch` handler: without one the browser does not route any
 * request through it, so it cannot slow the app down or serve a stale asset.
 */
'use strict';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', function (event) {
  var n = event.notification || {};
  var data = n.data || {};
  var url = data.url || '/';
  n.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      var target = null;
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        // prefer a tab that is already inside our app
        if (c.url && c.url.indexOf('/black-meet/') !== -1) { target = c; break; }
      }
      if (!target && list.length) target = list[0];
      if (!target) return self.clients.openWindow(url);
      var focused = ('focus' in target) ? target.focus() : Promise.resolve(target);
      return Promise.resolve(focused).then(function (win) {
        if (win && 'navigate' in win && url) {
          return win.navigate(url).catch(function () { return win; });
        }
        return win;
      });
    }).catch(function () {
      return self.clients.openWindow(url);
    })
  );
});

/* HK Workshop service worker.
   - Fetch: network-only passthrough (the app deliberately never caches — updates must land the
     moment GitHub Pages serves them, matching how deploys are verified by build marker).
   - Push: shows banner notifications (ramp clearances etc) even when the app is closed.
     Payload JSON: { title, body, tag, url } */
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(e){
  var d={};
  try{ d=e.data ? e.data.json() : {}; }catch(err){ d={ title:'HK Workshop', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'HK Workshop', {
    body: d.body || '',
    tag: d.tag || 'hkws',
    renotify: true,
    badge: 'hk-ring.png',
    icon: 'hk-ring.png',
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url=(e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(list){
    for(var i=0;i<list.length;i++){ if('focus' in list[i]) return list[i].focus(); }
    if(clients.openWindow) return clients.openWindow(url);
  }));
});

/* Images: cache-first with background refresh — product photos load instantly after the
   first view instead of re-downloading from RIMO/storage every scan. Everything else stays
   network-only so app updates land the moment GitHub Pages serves them. */
var IMG_CACHE='hk-img-v1';
self.addEventListener('fetch', function(e){
  var req=e.request;
  if(req.method!=='GET'||req.destination!=='image') return;   // passthrough for everything else
  e.respondWith(caches.open(IMG_CACHE).then(function(c){
    return c.match(req).then(function(hit){
      var net=fetch(req).then(function(res){ if(res&&res.ok){ try{c.put(req,res.clone());}catch(err){} } return res; }).catch(function(){ return hit; });
      return hit||net;
    });
  }));
});

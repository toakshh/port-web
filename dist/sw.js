const CACHE_NAME = 'zimension-cache-v4.34';

// Add whichever assets you want to precache here:
const PRECACHE_ASSETS = [
  '/',           // Your root files
  // '/index.html',
  '/manifest.json',
  '/sw.js'
];

// Listener for the install event - precaches our assets list on service worker install.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      let assetsToCache = [...PRECACHE_ASSETS];
      try {
        // Fetch the asset manifest JSON
        const response = await fetch('/asset-manifest.json');
      const manifest = await response.json();
      
      // Extract asset URLs from the "files" object
      const manifestUrls = Object.values(manifest.files);
      
      // Combine static assets and manifest assets
      assetsToCache = assetsToCache.concat(manifestUrls);
      } catch (e) {
        console.error('Failed to load asset manifest:', e);
      }
      return cache.addAll(assetsToCache);
    })
  );
});

self.addEventListener('activate', event => {
  console.log("Service Worker: Activated!");
  event.waitUntil(
      caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          console.log("service cache:", cache);
          if (cache !== CACHE_NAME) {
            console.log("Deleting old cache:", cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => {
      return self.clients.claim(); // Take control of open clients
    })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME).catch(e => {
          console.error('Cache open error:', e);
          return null;
      });
      
      if (cache) {
          // Match the request to our cache
          const cachedResponse = await cache.match(event.request);
          
          
          // If a valid cached response is found, return it
          if (cachedResponse) {
              return cachedResponse;
          }
          const networkResponse = await fetch(event.request);
          // If the network response is valid, clone and store it in the cache for future requests
          if (cache && networkResponse && networkResponse.status === 200) {
            
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse
      }
      
      // Otherwise, fetch from the network
      
  })());
});
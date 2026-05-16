async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    await navigator.serviceWorker.register("./service-worker.js");
    console.log("Service worker registered");
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}

registerServiceWorker();

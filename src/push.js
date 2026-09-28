import { useCallback, useEffect, useState } from "react";

function urlBase64ToUint8Array(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

export function usePush(vapidPublicKey) {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [permission, setPermission] = useState(supported ? Notification.permission : "default");

  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then(async (sub) => {
        setSubscribed(!!sub);
        // Re-register with the server in case the row was cleaned up.
        if (sub) await fetch("/api/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
      })
      .catch(() => {});
  }, [supported]);

  const subscribe = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") throw new Error("Notification permission was not granted.");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
      const res = await fetch("/api/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
      if (!res.ok) throw new Error("Server rejected the subscription.");
      setSubscribed(true);
      await fetch("/api/test-push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  }, [vapidPublicKey]);

  const unsubscribe = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }, []);

  const test = useCallback(async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const r = await fetch("/api/test-push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    if (!r.ok) setError("Test notification failed. Try turning alerts off and on again.");
  }, []);

  return {
    supported: supported && !!vapidPublicKey,
    iosNeedsInstall: isIOS() && !isStandalone(),
    subscribed, busy, error, permission, subscribe, unsubscribe, test,
  };
}

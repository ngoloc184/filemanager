// Generates the VAPID key pair for Web Push (chat notifications).
// Usage: npm run push:keys
// Put the printed lines in .env.local and in your host's environment
// (e.g. Vercel → Settings → Environment Variables), then redeploy.
// Keep VAPID_PRIVATE_KEY secret; changing the keys makes every device
// subscribe again on its next visit.
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("# a contact for the push services: your e-mail (mailto:) or site (https:)");
console.log("VAPID_SUBJECT=mailto:you@example.com");
